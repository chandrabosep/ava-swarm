// PM tick loop.
//
// Every TICK_INTERVAL_MS, iterate every user with an active session
// pointing to PM (PM doesn't sign onchain itself, but we still gate on
// session presence — no point making allocation decisions for a user
// who hasn't authorized the swarm). Pull portfolio snapshot, ask the
// LLM for a new allocation, publish AllocationIntent on AXL.

import {
  db,
  TOPICS,
  type AgentContext,
  type AllocationIntent,
  type SwarmMessage,
} from '@swarm/shared';

import { snapshot } from './portfolio.js';
import { decideAllocation } from './decide.js';
import { runDebate } from './debate.js';

// Outer loop fires every 30s. The per-user gate (profile.cadenceMinutes)
// inside tickUser() is what actually decides whether the LLM gets called.
// This needs to be ≤ the smallest profile cadence (degen = 1min) so we
// don't miss our chance to tick on time. 30s gives ~30s of jitter on
// when a tick fires after it's "due", which is fine.
//
// Override with PM_TICK_INTERVAL_SEC env if you want a different floor.
const TICK_INTERVAL_MS =
  (parseFloat(process.env.PM_TICK_INTERVAL_SEC ?? '30') || 30) * 1_000;
const DEFAULT_TOLERANCE_BPS = 300; // 3% — below this, Router noops.

export function startTick(ctx: AgentContext): () => void {
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try {
      await tickAll(ctx);
    } catch (err) {
      ctx.log.error('tick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  void run();
  const id = setInterval(run, TICK_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

async function tickAll(ctx: AgentContext): Promise<void> {
  const sessions = await db().session.findMany({
    where: { agent: 'executor', validUntil: { gt: new Date() } },
    select: { walletAddress: true },
  });

  for (const { walletAddress } of sessions) {
    // Defensive: schema declares this non-null, but a stale prisma
    // client + the legacy safe_address column mapping have produced
    // empty strings here in the past. A tick with no wallet would
    // publish a SwarmMessage missing walletAddress, which the router
    // can only drop. Skip cleanly.
    if (!walletAddress) {
      ctx.log.warn('session row with empty walletAddress skipped');
      continue;
    }
    try {
      await tickUser(ctx, walletAddress);
    } catch (err) {
      ctx.log.warn('user tick failed', {
        walletAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function tickUser(
  ctx: AgentContext,
  walletAddress: string,
): Promise<void> {
  // Read user's risk profile + per-knob overrides to derive the
  // effective config. PM uses the merged values for prompt/tolerance/
  // cadence on every tick.
  const user = (await db().user.findUnique({ where: { walletAddress } })) as
    | { riskProfile?: string; customConfig?: Record<string, unknown> | null }
    | null;
  const { resolveConfig } = await import('./profiles.js');
  const { name: profileName, config: profile } = resolveConfig(
    user?.riskProfile,
    user?.customConfig as never,
  );

  // Cadence gate: skip if PM ticked for this user too recently.
  const lastTick = await db().agentState.findUnique({
    where: { agent_walletAddress: { agent: 'pm', walletAddress } },
  });
  const lastMs =
    (lastTick?.state as { lastTick?: number } | null)?.lastTick ?? 0;
  const ageSec = (Date.now() - lastMs) / 1000;
  if (ageSec < profile.cadenceMinutes * 60) {
    return; // not due yet for this profile
  }

  ctx.log.info('ticking user', { walletAddress, profile: profileName });
  const pf = await snapshot(walletAddress);
  ctx.log.info('portfolio snapshot', {
    walletAddress,
    totalValueUsd: pf.totalValueUsd,
    positions: pf.positions.length,
  });
  if (pf.totalValueUsd <= 0) {
    ctx.log.info('skipping — empty portfolio', { walletAddress });
    return;
  }

  const draftIntent = await decideAllocation({
    walletAddress,
    snapshot: pf,
    toleranceBps: profile.toleranceBps,
    riskProfile: profileName,
  });

  // Inter-agent debate round: PM publishes the draft, ALM + Router post
  // feedback within the debate window, PM reconciles. Result is the
  // intent we actually persist + broadcast on pmAllocation. See
  // agents/pm/src/debate.ts for the protocol details.
  const debate = await runDebate(ctx, {
    walletAddress,
    intent: draftIntent,
    profile: profileName,
  });
  const intent = debate.reconciled;
  ctx.log.info('debate reconciled', {
    walletAddress,
    feedbackCount: debate.feedbackCount,
    finalTargets: intent.targets,
  });

  // Persist for audit, then broadcast for Router.
  const row = await db().intent.create({
    data: {
      walletAddress,
      fromAgent: 'pm',
      payload: intent as unknown as object,
      status: 'pending',
    },
  });
  await db().event.create({
    data: {
      walletAddress,
      agent: 'pm',
      kind: 'intent.created',
      payload: { intentId: row.id, targets: intent.targets },
    },
  });
  await db().agentState.upsert({
    where: { agent_walletAddress: { agent: 'pm', walletAddress } },
    update: {
      state: { lastTick: Date.now(), lastTargets: intent.targets },
    },
    create: {
      agent: 'pm',
      walletAddress,
      state: { lastTick: Date.now(), lastTargets: intent.targets },
    },
  });

  const msg: SwarmMessage<AllocationIntent> = {
    fromAgent: 'pm',
    walletAddress,
    ts: Date.now(),
    intentId: row.id,
    payload: intent,
  };
  // Three-layer transport: AXL gossip (multi-host), PG LISTEN/NOTIFY
  // (single-host instant), DB poll (resilience — already persistent
  // from the upstream upsert). Fan out to all three in parallel.
  const [axlPub] = await Promise.all([
    ctx.axl.publish({ topic: TOPICS.pmAllocation, payload: msg }),
    ctx.pg.publish({
      topic: TOPICS.pmAllocation,
      from: ctx.role,
      payload: msg,
    }),
  ]);
  ctx.log.info('allocation proposed', {
    walletAddress,
    targets: intent.targets,
    axlDelivered: axlPub.delivered,
    transport:
      axlPub.delivered > 0 ? 'axl+pg' : 'pg+db-poll-fallback',
  });
}
