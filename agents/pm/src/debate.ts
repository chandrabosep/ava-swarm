// PM-side of the inter-agent debate protocol.
//
// Flow:
//   1. PM produces a draft allocation (LLM call same as before).
//   2. PM publishes a `swarm.pm.draft` envelope on AXL + PG.
//   3. PM listens to `swarm.alm.feedback` and `swarm.router.feedback`
//      for a short collection window (default 2.5s).
//   4. PM reconciles: applies ALM adjustments + Router caps, drops
//      unroutable symbols, renormalizes weights to sum 1.0.
//   5. PM emits the final allocation via the existing pmAllocation
//      pipeline (AXL gossip + PG NOTIFY + DB row).
//
// Race-condition note: peer agents reply within microseconds of
// receiving the draft. If PM only subscribes to feedback channels
// *after* publishing the draft, those LISTENs register too late and
// every feedback message is dropped. Solution implemented below: a
// long-lived `startDebateInbox()` runs at PM boot, registers LISTEN
// on both feedback channels once, and accumulates messages into a
// per-draftId buffer. `runDebate` reads from that buffer after the
// debate window closes.

import {
  db,
  TOPICS,
  type AgentContext,
  type AlmFeedback,
  type DraftAllocation,
  type RouterFeedback,
  type SwarmMessage,
} from '@swarm/shared';

import type { AllocationIntent } from '@swarm/shared';

/** How long PM listens for peer feedback before reconciling and committing. */
const DEBATE_WINDOW_MS = parseInt(
  process.env.PM_DEBATE_WINDOW_MS ?? '2500',
  10,
);

let draftCounter = 0;
const newDraftId = (): string => `draft-${Date.now()}-${++draftCounter}`;

// =====================================================================
// Long-lived feedback inbox
// =====================================================================
// Buffers feedback by draftId. A debate round drains its draftId's
// buffer when the window expires. Buffers self-expire 30s after
// creation so abandoned draftIds don't leak memory.

interface BufferedFeedback {
  alm: Array<{ msg: AlmFeedback; walletAddress: string }>;
  router: Array<{ msg: RouterFeedback; walletAddress: string }>;
  expiresAt: number;
}

const feedbackByDraft = new Map<string, BufferedFeedback>();

function ensureBuffer(draftId: string): BufferedFeedback {
  let buf = feedbackByDraft.get(draftId);
  if (!buf) {
    buf = { alm: [], router: [], expiresAt: Date.now() + 30_000 };
    feedbackByDraft.set(draftId, buf);
  }
  return buf;
}

function gcBuffers(): void {
  const now = Date.now();
  for (const [id, buf] of feedbackByDraft) {
    if (buf.expiresAt < now) feedbackByDraft.delete(id);
  }
}

/**
 * Start the long-lived feedback inbox. Call once at PM boot. Keeps
 * LISTEN registrations open on both feedback channels so peers' NOTIFYs
 * never arrive at an empty subscriber set. Returns a stop function.
 */
export function startDebateInbox(ctx: AgentContext): () => void {
  let stopped = false;

  const consumeAlm = async () => {
    try {
      for await (const msg of ctx.pg.subscribe<SwarmMessage<AlmFeedback>>(
        TOPICS.almFeedback,
      )) {
        if (stopped) return;
        const fb = msg.payload?.payload;
        const wallet = msg.payload?.walletAddress;
        if (!fb?.draftId || !wallet) continue;
        ensureBuffer(fb.draftId).alm.push({ msg: fb, walletAddress: wallet });
      }
    } catch {
      // subscriber lifecycle ends with the process
    }
  };

  const consumeRouter = async () => {
    try {
      for await (const msg of ctx.pg.subscribe<SwarmMessage<RouterFeedback>>(
        TOPICS.routerFeedback,
      )) {
        if (stopped) return;
        const fb = msg.payload?.payload;
        const wallet = msg.payload?.walletAddress;
        if (!fb?.draftId || !wallet) continue;
        ensureBuffer(fb.draftId).router.push({
          msg: fb,
          walletAddress: wallet,
        });
      }
    } catch {
      // ignore
    }
  };

  // Also listen on AXL — same buffer, same handler. Both transports
  // funnel into the per-draftId map.
  const consumeAlmAxl = async () => {
    try {
      for await (const msg of ctx.axl.subscribe<SwarmMessage<AlmFeedback>>(
        TOPICS.almFeedback,
      )) {
        if (stopped) return;
        const fb = msg.payload?.payload;
        const wallet = msg.payload?.walletAddress;
        if (!fb?.draftId || !wallet) continue;
        ensureBuffer(fb.draftId).alm.push({ msg: fb, walletAddress: wallet });
      }
    } catch {
      // ignore
    }
  };

  const consumeRouterAxl = async () => {
    try {
      for await (const msg of ctx.axl.subscribe<SwarmMessage<RouterFeedback>>(
        TOPICS.routerFeedback,
      )) {
        if (stopped) return;
        const fb = msg.payload?.payload;
        const wallet = msg.payload?.walletAddress;
        if (!fb?.draftId || !wallet) continue;
        ensureBuffer(fb.draftId).router.push({
          msg: fb,
          walletAddress: wallet,
        });
      }
    } catch {
      // ignore
    }
  };

  void consumeAlm();
  void consumeRouter();
  void consumeAlmAxl();
  void consumeRouterAxl();

  // Periodic GC of expired draft buffers.
  const gcTimer = setInterval(gcBuffers, 30_000);

  return () => {
    stopped = true;
    clearInterval(gcTimer);
  };
}

// =====================================================================
// Per-tick debate round
// =====================================================================

export interface DebateInputs {
  walletAddress: string;
  intent: AllocationIntent;
  profile?: string;
}

export interface DebateOutcome {
  /** The reconciled allocation that should actually be published as final. */
  reconciled: AllocationIntent;
  /** Number of feedback messages received during the window. */
  feedbackCount: number;
  /** ALM messages, for the audit transcript. */
  alm: AlmFeedback[];
  /** Router messages, for the audit transcript. */
  router: RouterFeedback[];
}

/**
 * Run a debate round and return the reconciled allocation.
 *
 * Caller is expected to hand the reconciled allocation to the existing
 * pmAllocation publish pipeline. Debate adds messages around it but
 * doesn't replace the final delivery channel — the rest of the swarm
 * still consumes pmAllocation as today.
 *
 * Pre-condition: `startDebateInbox()` has been called once at PM boot.
 */
export async function runDebate(
  ctx: AgentContext,
  inputs: DebateInputs,
): Promise<DebateOutcome> {
  const { walletAddress, intent, profile } = inputs;
  const draftId = newDraftId();

  const draft: DraftAllocation = {
    kind: 'draft',
    draftId,
    targets: intent.targets,
    rationale: intent.rationale,
    profile,
  };

  // Pre-create the buffer so any arriving feedback (which can be
  // handled on the same tick of the event loop after publish() resolves)
  // has somewhere to land.
  ensureBuffer(draftId);

  // Persist the draft as an Event row so the dashboard can replay it.
  await db().event.create({
    data: {
      walletAddress,
      agent: 'pm',
      kind: 'debate.draft',
      payload: {
        draftId,
        targets: draft.targets,
        rationale: draft.rationale,
        profile,
      },
    },
  });

  // Publish the draft on both AXL and PG so peer agents on either
  // transport pick it up.
  const draftMsg: SwarmMessage<DraftAllocation> = {
    fromAgent: 'pm',
    walletAddress,
    ts: Date.now(),
    payload: draft,
  };
  await Promise.all([
    ctx.axl.publish({ topic: TOPICS.pmDraft, payload: draftMsg }).catch(() => {}),
    ctx.pg
      .publish({ topic: TOPICS.pmDraft, from: ctx.role, payload: draftMsg })
      .catch(() => {}),
  ]);
  ctx.log.info('debate draft published', {
    walletAddress,
    draftId,
    targets: draft.targets,
  });

  // Wait for the collection window to elapse. The long-lived inbox
  // (startDebateInbox) is already populating feedbackByDraft[draftId]
  // as messages arrive. We just sleep, then drain.
  await new Promise<void>((resolve) =>
    setTimeout(resolve, DEBATE_WINDOW_MS),
  );

  const buf = feedbackByDraft.get(draftId) ?? {
    alm: [],
    router: [],
    expiresAt: 0,
  };
  // Filter to feedback that names this wallet — peers might be running
  // multi-tenant and gossiping all of their drafts.
  const almFeedback = buf.alm
    .filter((b) => b.walletAddress === walletAddress)
    .map((b) => b.msg);
  const routerFeedback = buf.router
    .filter((b) => b.walletAddress === walletAddress)
    .map((b) => b.msg);
  // Drop the buffer once consumed.
  feedbackByDraft.delete(draftId);

  // Persist every feedback message as an Event row so the audit
  // transcript is recoverable from the DB even if AXL was the only
  // transport.
  for (const fb of almFeedback) {
    await db().event.create({
      data: {
        walletAddress,
        agent: 'alm',
        kind: 'debate.feedback',
        payload: {
          draftId,
          severity: fb.severity,
          concern: fb.concern,
          adjustments: fb.adjustments,
        },
      },
    });
  }
  for (const fb of routerFeedback) {
    await db().event.create({
      data: {
        walletAddress,
        agent: 'router',
        kind: 'debate.feedback',
        payload: {
          draftId,
          severity: fb.severity,
          concern: fb.concern,
          unroutableSymbols: fb.unroutableSymbols,
          notionalCaps: fb.notionalCaps,
        },
      },
    });
  }

  ctx.log.info('debate window closed', {
    walletAddress,
    draftId,
    alm: almFeedback.length,
    router: routerFeedback.length,
  });

  // Reconcile.
  const reconciled = reconcile(intent, almFeedback, routerFeedback);

  return {
    reconciled,
    feedbackCount: almFeedback.length + routerFeedback.length,
    alm: almFeedback,
    router: routerFeedback,
  };
}

/**
 * Apply ALM adjustments + drop Router-flagged unroutable symbols, then
 * renormalize so weights sum to 1.0. Caps from Router are advisory at
 * this stage — preflight will enforce them post-decompose; we don't
 * want PM rewriting weights based on KH balance because that bakes the
 * KH constraint into the strategy instead of treating it as a routing
 * concern.
 */
function reconcile(
  intent: AllocationIntent,
  alm: AlmFeedback[],
  router: RouterFeedback[],
): AllocationIntent {
  // 1. Apply ALM weight adjustments by symbol.
  const weightMap = new Map<string, number>(
    intent.targets.map((t) => [t.symbol.toUpperCase(), t.weight]),
  );
  for (const fb of alm) {
    if (!fb.adjustments) continue;
    for (const adj of fb.adjustments) {
      const sym = adj.symbol.toUpperCase();
      const cur = weightMap.get(sym) ?? 0;
      weightMap.set(sym, Math.max(0, cur + adj.deltaWeight));
    }
  }

  // 2. Drop symbols Router said are unroutable.
  const unroutable = new Set<string>();
  for (const fb of router) {
    for (const sym of fb.unroutableSymbols ?? []) {
      unroutable.add(sym.toUpperCase());
    }
  }
  for (const sym of unroutable) weightMap.delete(sym);

  // 3. Renormalize.
  const entries = Array.from(weightMap.entries()).filter(([, w]) => w > 0);
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  const targets =
    sum > 0
      ? entries.map(([symbol, w]) => ({ symbol, weight: w / sum }))
      : intent.targets; // nothing left? fall back to original

  // Append a one-line debate summary to the rationale so the activity
  // feed surfaces the consensus story.
  const debateNote = buildDebateNote(alm, router, unroutable);
  const rationale = debateNote
    ? `${intent.rationale ?? ''}\n\n[debate] ${debateNote}`.trim()
    : intent.rationale;

  return {
    ...intent,
    targets,
    rationale,
  };
}

function buildDebateNote(
  alm: AlmFeedback[],
  router: RouterFeedback[],
  unroutable: Set<string>,
): string {
  const parts: string[] = [];
  if (alm.length > 0) {
    parts.push(
      `ALM x${alm.length} (${alm.map((f) => f.severity).join(',')})`,
    );
  }
  if (router.length > 0) {
    parts.push(
      `Router x${router.length} (${router.map((f) => f.severity).join(',')})`,
    );
  }
  if (unroutable.size > 0) {
    parts.push(`dropped: ${Array.from(unroutable).join(', ')}`);
  }
  return parts.join(' · ');
}
