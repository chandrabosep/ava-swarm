// Postgres LISTEN/NOTIFY-backed mesh — drop-in replacement for the AXL
// HTTP client when the Gensyn AXL daemon isn't available.
//
// Why this exists: the AXL public Docker image (`gensynai/axl:latest`)
// doesn't ship yet, so the swarm's inter-agent comms layer is dead at
// boot. We already have a long-lived Supabase Postgres for state — its
// LISTEN/NOTIFY channels are perfectly serviceable for low-volume
// pub/sub between agents. Same API surface as `AxlClient` so no caller
// changes.
//
// Constraints worth remembering:
//   - pgbouncer (Supabase pooler at :6543) does NOT support LISTEN —
//     we connect via the direct URL (:5432) here.
//   - NOTIFY payload is capped ~8KB. Our messages are well under that.
//   - Channel names must be valid SQL identifiers; we slugify topic
//     strings so `swarm.pm.allocation` becomes `mesh_swarm_pm_allocation`.

import { Client, Pool, type Notification } from 'pg';
import { randomBytes } from 'node:crypto';

import { env } from './env.js';
import type { AgentRole } from './db.js';

interface MeshEnvelope<T = unknown> {
  from: string;
  kind?: string;
  payload: T;
  ts: number;
}

export interface MeshIdentity {
  peerId: string;
  pubkey: string;
}

export interface MeshPeer {
  peerId: string;
  agent?: AgentRole;
  endpoints?: string[];
}

export interface MeshSendOptions {
  to: string;
  kind: string;
  payload: unknown;
}

export interface MeshPublishOptions {
  topic: string;
  payload: unknown;
}

export interface MeshInbound<T = unknown> {
  from: string;
  kind: string;
  payload: T;
  receivedAt: string;
}

const slug = (topic: string): string =>
  'mesh_' + topic.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();

const peerChannel = (peerId: string): string => slug('peer.' + peerId);

export class PgMesh {
  readonly peerId: string;
  /**
   * Pool for publishes. A pg `Client` can only run one query at a time —
   * concurrent publishes would race and trigger a deprecation warning,
   * so a small pool absorbs that.
   */
  private notifyPool: Pool | null = null;
  /** Single dedicated connection that owns all `LISTEN` channels. */
  private listenClient: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  private listenedChannels = new Set<string>();
  private handlers = new Map<string, Set<(env: MeshEnvelope) => void>>();

  constructor(role: AgentRole) {
    this.peerId = `${role}-${randomBytes(4).toString('hex')}`;
  }

  /** Lazily open both pg connections. Idempotent. */
  private async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      const url = env.directUrl();
      this.notifyPool = new Pool({ connectionString: url, max: 4 });
      this.listenClient = new Client({ connectionString: url });
      await this.listenClient.connect();
      this.listenClient.on('notification', (msg) => this.dispatch(msg));
      this.listenClient.on('error', () => {
        // Surface as a connection-reset; subscribers' retry loops handle it.
        this.connectPromise = null;
      });
      // Always listen on our own peer channel so `send()` from peers lands.
      await this.ensureListening(peerChannel(this.peerId));
    })();
    return this.connectPromise;
  }

  private async ensureListening(channel: string): Promise<void> {
    if (this.listenedChannels.has(channel)) return;
    await this.listenClient!.query(`LISTEN "${channel}"`);
    this.listenedChannels.add(channel);
  }

  private dispatch(msg: Notification): void {
    if (!msg.payload) return;
    let envv: MeshEnvelope;
    try {
      envv = JSON.parse(msg.payload) as MeshEnvelope;
    } catch {
      return;
    }
    const set = this.handlers.get(msg.channel);
    if (set) for (const h of set) h(envv);
  }

  async identity(): Promise<MeshIdentity> {
    await this.connect();
    return { peerId: this.peerId, pubkey: '0x' };
  }

  async peers(): Promise<MeshPeer[]> {
    // Not maintained for v1 — the dashboard reads agent presence from the
    // heartbeat events table instead.
    return [];
  }

  async publish(opts: MeshPublishOptions): Promise<{ ok: true }> {
    await this.connect();
    const env: MeshEnvelope = {
      from: this.peerId,
      payload: opts.payload,
      ts: Date.now(),
    };
    await this.notifyPool!.query('SELECT pg_notify($1, $2)', [
      slug(opts.topic),
      JSON.stringify(env),
    ]);
    return { ok: true };
  }

  async send(opts: MeshSendOptions): Promise<{ ok: true }> {
    await this.connect();
    const env: MeshEnvelope = {
      from: this.peerId,
      kind: opts.kind,
      payload: opts.payload,
      ts: Date.now(),
    };
    await this.notifyPool!.query('SELECT pg_notify($1, $2)', [
      peerChannel(opts.to),
      JSON.stringify(env),
    ]);
    return { ok: true };
  }

  /**
   * Long-lived subscribe loop. Each call registers a handler on the
   * channel; multiple subscribes on the same topic share one LISTEN.
   * Yields one message at a time, suitable for `for await` consumption.
   */
  async *subscribe<T = unknown>(
    topic: string,
    abort?: AbortSignal,
  ): AsyncGenerator<MeshInbound<T>> {
    await this.connect();
    const channel = slug(topic);
    await this.ensureListening(channel);

    const queue: MeshEnvelope[] = [];
    let resolveNext: ((v: MeshEnvelope | null) => void) | null = null;
    const handler = (envv: MeshEnvelope): void => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(envv);
      } else {
        queue.push(envv);
      }
    };
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);

    const onAbort = (): void => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    };
    abort?.addEventListener('abort', onAbort, { once: true });

    try {
      while (!abort?.aborted) {
        let envv: MeshEnvelope | null;
        if (queue.length > 0) {
          envv = queue.shift()!;
        } else {
          envv = await new Promise<MeshEnvelope | null>((r) => {
            resolveNext = r;
          });
        }
        if (!envv) break;
        yield {
          from: envv.from,
          kind: envv.kind ?? '',
          payload: envv.payload as T,
          receivedAt: new Date(envv.ts).toISOString(),
        };
      }
    } finally {
      this.handlers.get(channel)?.delete(handler);
    }
  }

  async close(): Promise<void> {
    try {
      await this.listenClient?.end();
    } catch {
      /* best-effort */
    }
    try {
      await this.notifyPool?.end();
    } catch {
      /* best-effort */
    }
  }
}
