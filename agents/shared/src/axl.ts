// Thin client over Gensyn's Agent eXchange Layer (AXL).
//
// AXL runs as a local binary that exposes an HTTP API on localhost. Each
// agent process talks to its own AXL daemon. AXL handles encryption,
// peer discovery, and routing — we just send JSON over HTTP.
//
// API surface used here (subset of AXL's full surface — we expand as we
// need it):
//   POST /a2a/send        — point-to-point message to a known peer
//   POST /pubsub/publish  — publish to a topic
//   GET  /pubsub/subscribe?topic=... — long-poll subscribe
//   GET  /peers           — list known peers
//   GET  /identity        — this node's peer id + pubkey
//
// See https://docs.gensyn.ai/tech/agent-exchange-layer for the full API.

import type { AgentRole } from './db.js';

export interface AxlIdentity {
  peerId: string;
  pubkey: string;
}

export interface AxlPeer {
  peerId: string;
  agent?: AgentRole;
  endpoints?: string[];
}

export interface SendOptions {
  /** Peer id of the recipient. */
  to: string;
  /** Application-level message kind, e.g. 'intent.submit'. */
  kind: string;
  payload: unknown;
}

export interface PublishOptions {
  topic: string;
  payload: unknown;
}

export interface InboundMessage<T = unknown> {
  /** Sender peer id. */
  from: string;
  kind: string;
  payload: T;
  /** AXL-attached envelope metadata. */
  receivedAt: string;
}

export class AxlClient {
  constructor(public readonly endpoint: string) {}

  async identity(): Promise<AxlIdentity> {
    return this.get('/identity');
  }

  async peers(): Promise<AxlPeer[]> {
    return this.get('/peers');
  }

  async send(opts: SendOptions): Promise<{ ok: true }> {
    return this.post('/a2a/send', opts);
  }

  async publish(opts: PublishOptions): Promise<{ ok: true }> {
    return this.post('/pubsub/publish', opts);
  }

  /**
   * Long-poll subscribe. Yields one InboundMessage at a time. Caller is
   * expected to wrap in a `for await` loop. Restarts on transient errors
   * with exponential backoff up to 30s.
   */
  async *subscribe<T = unknown>(
    topic: string,
    abort?: AbortSignal,
  ): AsyncGenerator<InboundMessage<T>> {
    let backoff = 250;
    while (!abort?.aborted) {
      try {
        const url = new URL('/pubsub/subscribe', this.endpoint);
        url.searchParams.set('topic', topic);
        const res = await fetch(url, { signal: abort });
        if (!res.ok) throw new Error(`AXL subscribe ${res.status}`);
        if (!res.body) throw new Error('AXL subscribe: no body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Newline-delimited JSON.
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            yield JSON.parse(line) as InboundMessage<T>;
          }
        }
        backoff = 250; // reset after a clean disconnect
      } catch (err) {
        if (abort?.aborted) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, this.endpoint));
    if (!res.ok) throw new Error(`AXL ${path} ${res.status}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AXL ${path} ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Canonical AXL pubsub topics used across the swarm. Centralized so a
 * typo in one agent doesn't silently send into a black hole.
 */
export const TOPICS = {
  /** PM publishes target-allocation messages. */
  pmAllocation: 'swarm.pm.allocation',
  /** ALM publishes rebalance intents. */
  almRebalance: 'swarm.alm.rebalance',
  /** Router publishes routed intents (Executor consumes). */
  routerRouted: 'swarm.router.routed',
  /** Executor publishes execution receipts (everyone consumes for audit). */
  executorReceipt: 'swarm.executor.receipt',
  /** Anyone can listen for status heartbeats. */
  heartbeat: 'swarm.heartbeat',
  /**
   * OTC pre-trade gossip. Routers publish pending swaps here so peers
   * can match opposite intents internally before routing to Uniswap.
   * The novel primitive — agents settle directly when possible, use
   * Uniswap as the liquidity backstop instead of the first hop.
   */
  otcAdvertise: 'swarm.otc.advertise',
  /** Two-way confirmation of a proposed match. */
  otcConfirm: 'swarm.otc.confirm',
} as const;
