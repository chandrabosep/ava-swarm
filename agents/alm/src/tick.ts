// Per-tenant tick loop.
//
// Every TICK_INTERVAL_MS, iterate every user with an active ALM session.
// For each user × chain, read their positions, analyze them, and emit a
// RebalanceIntent on AXL for any out-of-range position.
//
// Idempotent: Router de-dupes intents by (walletAddress, poolId, reason)
// Note: agentState lookup uses agent_walletAddress composite key from Prisma.
// in a recent window, so re-emitting the same finding is harmless.

import {
  db,
  TOPICS,
  type AgentContext,
  type RebalanceIntent,
  type SupportedChain,
  type SwarmMessage,
} from '@swarm/shared';

import { readPositions } from './positions.js';
import { analyzePositions } from './strategy.js';

const TICK_INTERVAL_MS = 60_000;

const CHAINS_TO_SCAN: SupportedChain[] = ['mainnet', 'base', 'unichain'];

export function startTick(ctx: AgentContext): () => void {
  let stopped = false;
  const log = ctx.log;

  const run = async () => {
    if (stopped) return;
    try {
      await tickAll(ctx);
    } catch (err) {
      log.error('tick failed', {
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
  // All users that have an unexpired ALM session.
  const sessions = await db().session.findMany({
    where: { agent: 'alm', validUntil: { gt: new Date() } },
    select: { walletAddress: true },
  });

  for (const { walletAddress } of sessions) {
    for (const chain of CHAINS_TO_SCAN) {
      try {
        await tickUser(ctx, walletAddress as `0x${string}`, chain);
      } catch (err) {
        ctx.log.warn('user tick failed', {
          walletAddress,
          chain,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

async function tickUser(
  ctx: AgentContext,
  walletAddress: `0x${string}`,
  chain: SupportedChain,
): Promise<void> {
  const positions = await readPositions(walletAddress, chain);
  if (positions.length === 0) return;

  const analyses = await analyzePositions(positions, chain);
  const drifted = analyses.filter((a) => a.verdict === 'out-of-range');

  // Cache the snapshot regardless of verdict so the dashboard can show
  // "last looked: now, 0 drifted".
  await db().agentState.upsert({
    where: { agent_walletAddress: { agent: 'alm', walletAddress } },
    update: {
      state: {
        chain,
        positions: positions.length,
        drifted: drifted.length,
        lastTick: Date.now(),
      },
    },
    create: {
      agent: 'alm',
      walletAddress,
      state: {
        chain,
        positions: positions.length,
        drifted: drifted.length,
        lastTick: Date.now(),
      },
    },
  });

  for (const analysis of drifted) {
    await emitRebalanceIntent(ctx, walletAddress, chain, analysis);
  }
}

async function emitRebalanceIntent(
  ctx: AgentContext,
  walletAddress: `0x${string}`,
  chain: SupportedChain,
  analysis: { position: { poolId: string; liquidity: bigint }; currentTick: number },
): Promise<void> {
  const intent: RebalanceIntent = {
    kind: 'rebalance',
    chain,
    poolId: analysis.position.poolId,
    // ALM doesn't pick the swap direction yet — Router does, after
    // looking at total inventory across all positions. Placeholders.
    tokenIn: '0x',
    tokenOut: '0x',
    amountIn: '0',
    reason: 'range-drift',
  };

  const row = await db().intent.create({
    data: {
      walletAddress,
      fromAgent: 'alm',
      payload: intent as unknown as object,
      status: 'pending',
    },
  });

  await db().event.create({
    data: {
      walletAddress,
      agent: 'alm',
      kind: 'intent.created',
      payload: { intentId: row.id, reason: 'range-drift', poolId: intent.poolId },
    },
  });

  const msg: SwarmMessage<RebalanceIntent> = {
    fromAgent: 'alm',
    walletAddress,
    ts: Date.now(),
    payload: intent,
  };
  await ctx.axl.publish({ topic: TOPICS.almRebalance, payload: msg });
  ctx.log.info('rebalance proposed', {
    walletAddress,
    chain,
    poolId: analysis.position.poolId,
    intentId: row.id,
  });
}
