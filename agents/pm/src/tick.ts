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

const TICK_INTERVAL_MS = 5 * 60_000;
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
    select: { safeAddress: true },
  });

  for (const { safeAddress } of sessions) {
    try {
      await tickUser(ctx, safeAddress);
    } catch (err) {
      ctx.log.warn('user tick failed', {
        safeAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function tickUser(
  ctx: AgentContext,
  safeAddress: string,
): Promise<void> {
  ctx.log.info('ticking user', { safeAddress });
  const pf = await snapshot(safeAddress);
  ctx.log.info('portfolio snapshot', {
    safeAddress,
    totalValueUsd: pf.totalValueUsd,
    positions: pf.positions.length,
  });
  if (pf.totalValueUsd <= 0) {
    ctx.log.info('skipping — empty portfolio', { safeAddress });
    return;
  }

  const intent = await decideAllocation({
    safeAddress,
    snapshot: pf,
    toleranceBps: DEFAULT_TOLERANCE_BPS,
  });

  // Persist for audit, then broadcast for Router.
  const row = await db().intent.create({
    data: {
      safeAddress,
      fromAgent: 'pm',
      payload: intent as unknown as object,
      status: 'pending',
    },
  });
  await db().event.create({
    data: {
      safeAddress,
      agent: 'pm',
      kind: 'intent.created',
      payload: { intentId: row.id, targets: intent.targets },
    },
  });
  await db().agentState.upsert({
    where: { agent_safeAddress: { agent: 'pm', safeAddress } },
    update: {
      state: { lastTick: Date.now(), lastTargets: intent.targets },
    },
    create: {
      agent: 'pm',
      safeAddress,
      state: { lastTick: Date.now(), lastTargets: intent.targets },
    },
  });

  const msg: SwarmMessage<AllocationIntent> = {
    fromAgent: 'pm',
    safeAddress,
    ts: Date.now(),
    payload: intent,
  };
  await ctx.axl.publish({ topic: TOPICS.pmAllocation, payload: msg });
  ctx.log.info('allocation proposed', {
    safeAddress,
    targets: intent.targets,
  });
}
