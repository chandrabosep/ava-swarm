// DB-polling fallback for intent fan-out.
//
// When AXL is up, agents subscribe to topics and react to gossip. When
// AXL is down (rollout in progress, daemon not running, etc.), they
// instead poll the Intent table for rows the upstream agent has already
// persisted. PM/Router both write Intent rows before broadcasting, so
// the DB is the source of truth either way.
//
// Each poller tracks consumed ids in memory, but also flips the row's
// status forward (e.g. pending → routing) atomically so a restarted
// agent doesn't re-process. The status enum:
//   pending  — PM wrote it; Router hasn't seen it yet
//   routing  — Router picked it up
//   routed   — Router wrote a downstream Intent for Executor
//   executing — Executor picked it up
//   executed — onchain receipt landed (or failed terminally)

import { db, type AgentRole } from './db.js';

export interface PollOptions<T> {
  /** Which agent wrote the upstream intent. */
  fromAgent: AgentRole;
  /** Status the upstream row is in when Router/Executor hasn't seen it. */
  pendingStatus: string;
  /** Status to flip the row to once we begin processing (claim it). */
  inFlightStatus: string;
  /** Status to set after the handler resolves (success). */
  completedStatus?: string;
  /** Status to set if the handler throws. */
  failedStatus?: string;
  /** Poll interval ms. */
  intervalMs?: number;
  /** Skip rows that were created less than this many ms ago. Gives
   *  fast transports (AXL gossip, PG NOTIFY) a head start to claim
   *  the row first. Default 1500ms — well above the ~1ms PG NOTIFY
   *  delivery latency. */
  graceMs?: number;
  /** Handler — called once per claimed row. */
  handle: (row: {
    id: string;
    safeAddress: string;
    payload: T;
  }) => Promise<void>;
  /** Logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: object) => void;
}

export function startIntentPoll<T>(opts: PollOptions<T>): () => void {
  const interval = opts.intervalMs ?? 2_000;
  const graceMs = opts.graceMs ?? 1_500;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      // Two-step claim: find candidates, then per-row updateMany with
      // a status filter to atomically transition only rows that are
      // still in pending state. If a fast transport (PG NOTIFY / AXL)
      // already transitioned the row, our update affects 0 rows and
      // we skip processing. This is the dedup primitive that lets
      // all three transports race safely.
      const cutoff = new Date(Date.now() - graceMs);
      const candidates = await db().intent.findMany({
        where: {
          fromAgent: opts.fromAgent,
          status: opts.pendingStatus,
          createdAt: { lt: cutoff },
        },
        orderBy: { createdAt: 'asc' },
        take: 16,
      });
      const claimed: typeof candidates = [];
      for (const row of candidates) {
        const res = await db().intent.updateMany({
          where: { id: row.id, status: opts.pendingStatus },
          data: { status: opts.inFlightStatus },
        });
        if (res.count > 0) claimed.push(row);
      }

      for (const row of claimed) {
        try {
          await opts.handle({
            id: row.id,
            safeAddress: row.safeAddress,
            payload: row.payload as unknown as T,
          });
          if (opts.completedStatus) {
            await db().intent.update({
              where: { id: row.id },
              data: { status: opts.completedStatus },
            });
          }
        } catch (err) {
          opts.log('warn', 'poll handler failed', {
            intentId: row.id,
            err: err instanceof Error ? err.message : String(err),
          });
          if (opts.failedStatus) {
            await db()
              .intent.update({
                where: { id: row.id },
                data: { status: opts.failedStatus },
              })
              .catch(() => {});
          }
        }
      }
    } catch (err) {
      opts.log('warn', 'poll loop error', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  void tick();
  const id = setInterval(tick, interval);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
