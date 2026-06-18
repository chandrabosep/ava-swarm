// Postgres LISTEN/NOTIFY gossip bus — instant cross-process pub/sub.
//
// Why this exists: AXL is the production transport for cross-host swarm
// communication. On a single host where every agent shares one AXL
// daemon, AXL can't loopback (the protocol's anti-self-peer guard tears
// down loopback connections — see axl-node logs for ErrBadKey traces).
// We need a real-time bus that works alongside the persistent
// intent-poll fallback.
//
// LISTEN/NOTIFY gives us sub-ms cross-process delivery using the same
// Postgres we already have. Channel names mirror AXL topics:
//   swarm.pm.allocation, swarm.alm.rebalance, swarm.router.routed,
//   swarm.executor.receipt, swarm.heartbeat, swarm.otc.{advertise,confirm}
//
// Caveat: pgbouncer in transaction mode (Supabase's pooler URL) does
// NOT support LISTEN — the connection is recycled between txns and
// the LISTEN registration is lost. We use DIRECT_URL (port 5432) for
// the gossip connection. Falls back gracefully if neither is set.
//
// Channel name normalization: Postgres channel names are case-folded
// and limited to 63 chars; we replace dots with double-underscores so
// "swarm.pm.allocation" becomes "swarm__pm__allocation".

import pg from 'pg';
import { env } from './env.js';

export interface GossipMessage<T = unknown> {
  topic: string;
  from: string; // agent role of the publisher
  payload: T;
  receivedAt: string;
}

const CHANNEL_PREFIX = 'sg_'; // PG channels can't start with a digit

function chanFor(topic: string): string {
  return CHANNEL_PREFIX + topic.replace(/\./g, '__').toLowerCase();
}

interface QueueItem<T> {
  resolve: (value: GossipMessage<T> | undefined) => void;
}

type LifecycleHook = (event: string, meta?: Record<string, unknown>) => void;

export class PgGossipBus {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private listeners = new Map<string, Set<(msg: GossipMessage) => void>>();
  private connectionUrl: string;
  /** Hook for observability — agents can wire `ctx.log` in. */
  public onLifecycle: LifecycleHook = () => {};

  constructor(connectionUrl: string) {
    this.connectionUrl = connectionUrl;
  }

  /** Lazy connect — first publish or subscribe triggers it. */
  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new pg.Client({ connectionString: this.connectionUrl });
      c.on('notification', (msg: pg.Notification) => {
        const channel = msg.channel;
        const subs = this.listeners.get(channel);
        if (!subs || !msg.payload) return;
        let envelope: { topic: string; from: string; payload: unknown };
        try {
          envelope = JSON.parse(msg.payload);
        } catch {
          return;
        }
        const out: GossipMessage = {
          topic: envelope.topic,
          from: envelope.from,
          payload: envelope.payload,
          receivedAt: new Date().toISOString(),
        };
        for (const cb of subs) cb(out);
      });
      // Errors on the gossip socket are non-fatal — agents fall back to
      // intent-poll. Reconnect on next ensureConnected().
      c.on('error', (err: Error) => {
        this.onLifecycle('pg-gossip error', { err: err.message });
        this.client = null;
        this.connecting = null;
      });
      c.on('end', () => {
        this.onLifecycle('pg-gossip disconnected');
        this.client = null;
        this.connecting = null;
      });
      try {
        await c.connect();
        this.client = c;
        this.onLifecycle('pg-gossip connected');
      } catch (err) {
        this.onLifecycle('pg-gossip connect failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        this.connecting = null;
        throw err;
      }
    })();
    return this.connecting.catch(() => {
      /* swallow; re-throw on next attempt */
    });
  }

  async publish<T>(opts: {
    topic: string;
    from: string;
    payload: T;
  }): Promise<{ ok: boolean; delivered: boolean }> {
    try {
      await this.ensureConnected();
      if (!this.client) return { ok: false, delivered: false };
      const envelope = JSON.stringify({
        topic: opts.topic,
        from: opts.from,
        payload: opts.payload,
      });
      const channel = chanFor(opts.topic);
      // Postgres NOTIFY payload is limited to 8000 bytes. Anything bigger
      // we just don't gossip — DB poll catches it.
      if (envelope.length > 7800) return { ok: false, delivered: false };
      await this.client.query('SELECT pg_notify($1, $2)', [channel, envelope]);
      return { ok: true, delivered: true };
    } catch (err) {
      this.onLifecycle('pg-gossip publish failed', {
        topic: opts.topic,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, delivered: false };
    }
  }

  async *subscribe<T = unknown>(
    topic: string,
    abort?: AbortSignal,
  ): AsyncGenerator<GossipMessage<T>> {
    await this.ensureConnected();
    if (!this.client) return;

    const channel = chanFor(topic);
    let subs = this.listeners.get(channel);
    if (!subs) {
      subs = new Set();
      this.listeners.set(channel, subs);
      await this.client.query(`LISTEN "${channel}"`);
      this.onLifecycle('pg-gossip listening', { topic, channel });
    }

    // Bridge the event-emitter style notification handler to an async
    // iterator with a tiny in-memory queue.
    const queue: GossipMessage<T>[] = [];
    const waiters: QueueItem<T>[] = [];
    const cb = (msg: GossipMessage) => {
      const typed = msg as GossipMessage<T>;
      const next = waiters.shift();
      if (next) next.resolve(typed);
      else queue.push(typed);
    };
    subs.add(cb);

    const cleanup = () => {
      subs!.delete(cb);
      while (waiters.length) waiters.shift()!.resolve(undefined);
    };
    abort?.addEventListener('abort', cleanup, { once: true });

    try {
      while (!abort?.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        const next = await new Promise<GossipMessage<T> | undefined>((resolve) => {
          waiters.push({ resolve });
        });
        if (!next) return;
        yield next;
      }
    } finally {
      cleanup();
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c) await c.end().catch(() => {});
  }
}

let singleton: PgGossipBus | null = null;

/** Process-wide singleton — multiple agents in the same process share one
 *  LISTEN connection. Uses DIRECT_URL if set, else DATABASE_URL (which
 *  may be pgbouncer'd and silently fail — that's OK, fallback chain
 *  has DB poll). */
export function pgGossip(): PgGossipBus {
  if (singleton) return singleton;
  // Prefer DIRECT_URL (port 5432) — pgbouncer in tx-pool mode (port
  // 6543) silently drops LISTEN registrations between transactions.
  let url = '';
  try {
    url = env.directUrl();
  } catch {
    url = env.databaseUrl();
  }
  singleton = new PgGossipBus(url);
  return singleton;
}
