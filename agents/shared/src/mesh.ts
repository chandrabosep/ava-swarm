// Inter-agent mesh — a thin adapter over the Postgres LISTEN/NOTIFY bus.
//
// This replaces the old AXL HTTP client. AXL was a cross-host gossip
// daemon; on a single host it couldn't loopback (anti-self-peer guard)
// so it never actually carried messages — Postgres gossip + the DB-poll
// fallback did. We dropped AXL entirely and route the same publish/
// subscribe API straight onto the shared `pgGossip` singleton, so every
// agent in a process shares ONE LISTEN connection (stays under Supabase's
// session-pool cap).
//
// The API mirrors what agents already call as `ctx.axl.publish(...)` /
// `ctx.axl.subscribe(...)`, so no agent code changed when AXL was removed.

import { pgGossip, type PgGossipBus } from './pg-gossip.js';
import type { AgentRole } from './db.js';

export interface MeshIdentity {
  peerId: string;
  pubkey: string;
}

export interface MeshInbound<T = unknown> {
  from: string;
  kind: string;
  payload: T;
  receivedAt: string;
}

/** Postgres-gossip-backed mesh bus. Construct one per agent; it reuses
 *  the process-wide `pgGossip` connection under the hood. */
export class MeshBus {
  constructor(
    private readonly role: AgentRole,
    private readonly bus: PgGossipBus = pgGossip(),
  ) {}

  /** No network probe — identity is just the agent role now. */
  async identity(): Promise<MeshIdentity> {
    return { peerId: this.role, pubkey: '0x' };
  }

  async publish(opts: {
    topic: string;
    payload: unknown;
  }): Promise<{ ok: boolean; delivered: boolean }> {
    return this.bus.publish({
      topic: opts.topic,
      from: this.role,
      payload: opts.payload,
    });
  }

  /** Point-to-point send to a specific peer, over a peer-addressed gossip
   *  channel. Used by the OTC matcher (router/src/otc.ts). In single-host
   *  runs no remote peer is listening — same as the old AXL behaviour when
   *  the topology was empty. */
  async send(opts: { to: string; data: string }): Promise<{ ok: boolean }> {
    const res = await this.bus.publish({
      topic: `peer.${opts.to}`,
      from: this.role,
      payload: opts.data,
    });
    return { ok: res.ok };
  }

  async *subscribe<T = unknown>(
    topic: string,
    abort?: AbortSignal,
  ): AsyncGenerator<MeshInbound<T>> {
    for await (const m of this.bus.subscribe<T>(topic, abort)) {
      yield {
        from: m.from,
        kind: m.topic,
        payload: m.payload,
        receivedAt: m.receivedAt,
      };
    }
  }
}
