// Client for the real Gensyn AXL node API.
//
// AXL exposes a small HTTP surface on its local port:
//   GET  /topology   — connected peers
//   POST /send       — send a message to one peer
//   GET  /recv       — pull next message from this node's inbox
//
// We model "topics" on top of /send + /recv: each agent broadcasts to
// every known peer via /send, and the receiver tags inbound messages
// with the topic + payload it carried. Cheaper than building a real
// pubsub layer, good enough for swarm gossip at this scale.

import type { AgentRole } from './db.js';

export interface TopologyEntry {
  publicKey: string;
  address?: string;
}

export interface SendOptions {
  to: string;
  data: string;
}

export interface InboundMessage<T = unknown> {
  from: string;
  kind: string;
  payload: T;
  receivedAt: string;
}

interface Envelope {
  topic: string;
  kind: string;
  payload: unknown;
  ts: number;
}

export class AxlClient {
  private peerCache: TopologyEntry[] = [];
  private peerCacheAt = 0;
  private static readonly PEER_TTL_MS = 5_000;

  constructor(public readonly endpoint: string) {}

  async topology(): Promise<TopologyEntry[]> {
    const res = await fetch(new URL('/topology', this.endpoint));
    if (!res.ok) throw new Error(`AXL /topology ${res.status}`);
    const body = (await res.json()) as
      | TopologyEntry[]
      | { peers: TopologyEntry[] };
    return Array.isArray(body) ? body : (body.peers ?? []);
  }

  /** AXL has no /identity endpoint — boot uses topology() to confirm liveness. */
  async identity(): Promise<{ peerId: string; pubkey: string }> {
    await this.topology();
    return { peerId: 'local', pubkey: '0x' };
  }

  async peers(): Promise<TopologyEntry[]> {
    if (Date.now() - this.peerCacheAt < AxlClient.PEER_TTL_MS) {
      return this.peerCache;
    }
    this.peerCache = await this.topology();
    this.peerCacheAt = Date.now();
    return this.peerCache;
  }

  async send(opts: SendOptions): Promise<{ ok: true }> {
    const res = await fetch(new URL('/send', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: opts.to, data: opts.data }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AXL /send ${res.status}: ${text}`);
    }
    return { ok: true };
  }

  async publish(opts: { topic: string; payload: unknown }): Promise<{ ok: true }> {
    // If AXL is offline, swallow the error: the swarm degrades gracefully
    // (Router/Executor poll the DB for new intents instead of relying on
    // gossip). We don't want a missing peer mesh to nuke a tick.
    let peers: TopologyEntry[];
    try {
      peers = await this.peers();
    } catch {
      return { ok: true };
    }
    const envelope: Envelope = {
      topic: opts.topic,
      kind: opts.topic,
      payload: opts.payload,
      ts: Date.now(),
    };
    const data = JSON.stringify(envelope);
    await Promise.all(
      peers.map((p) =>
        this.send({ to: p.publicKey, data }).catch(() => {
          /* one bad peer shouldn't break the broadcast */
        }),
      ),
    );
    return { ok: true };
  }

  async *subscribe<T = unknown>(
    topic: string,
    abort?: AbortSignal,
  ): AsyncGenerator<InboundMessage<T>> {
    let backoff = 250;
    while (!abort?.aborted) {
      try {
        const res = await fetch(new URL('/recv', this.endpoint), { signal: abort });
        if (!res.ok) throw new Error(`AXL /recv ${res.status}`);
        const body = (await res.json()) as
          | { from: string; data: string }
          | Array<{ from: string; data: string }>;
        const items = Array.isArray(body) ? body : [body];
        for (const item of items) {
          if (!item?.data) continue;
          let envelope: Envelope;
          try {
            envelope = JSON.parse(item.data) as Envelope;
          } catch {
            continue;
          }
          if (envelope.topic !== topic) continue;
          yield {
            from: item.from,
            kind: envelope.kind,
            payload: envelope.payload as T,
            receivedAt: new Date().toISOString(),
          };
        }
        backoff = 250;
      } catch (err) {
        if (abort?.aborted) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
}

export const TOPICS = {
  pmAllocation: 'swarm.pm.allocation',
  almRebalance: 'swarm.alm.rebalance',
  routerRouted: 'swarm.router.routed',
  executorReceipt: 'swarm.executor.receipt',
  heartbeat: 'swarm.heartbeat',
  otcAdvertise: 'swarm.otc.advertise',
  otcConfirm: 'swarm.otc.confirm',
} as const;

export type { AgentRole };
