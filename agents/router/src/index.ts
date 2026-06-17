// Intent Router.
//
// Two AXL inboxes:
//   - swarm.pm.allocation  — PM proposes target weights → decompose into
//                            pair swaps, dispatch each to Executor
//   - swarm.alm.rebalance  — ALM flags a drift → for now we forward as a
//                            single swap to Executor (real netting in B-2)
//
// Phase B-1 keeps decomposition simple: pair largest sell with largest
// buy until exhausted. Phase B-2+ can plug in a proper LP solver.

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  type AllocationIntent,
  type AgentContext,
  type RebalanceIntent,
  type SupportedChain,
  type SwarmMessage,
} from '@swarm/shared';

import { decompose } from './decompose.js';
import { dispatch } from './dispatch.js';
import { currentSlices } from './portfolio.js';

/** Phase B-1: settle every intent on the user's primary chain. */
const PRIMARY_CHAIN: SupportedChain = 'unichain';

async function main() {
  const ctx = await bootAgent('router');
  const stopHeartbeat = startHeartbeat(ctx);

  // PM allocation inbox
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<AllocationIntent>>(
      TOPICS.pmAllocation,
    )) {
      const env = msg.payload;
      if (!env || env.payload?.kind !== 'allocation') continue;
      try {
        await handleAllocation(ctx, env.safeAddress, env.payload);
      } catch (err) {
        ctx.log.warn('allocation handler failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();

  // ALM rebalance inbox
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<RebalanceIntent>>(
      TOPICS.almRebalance,
    )) {
      const env = msg.payload;
      if (!env || env.payload?.kind !== 'rebalance') continue;
      try {
        await handleRebalance(ctx, env.safeAddress, env.payload);
      } catch (err) {
        ctx.log.warn('rebalance handler failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();

  ctx.log.info('ready', {
    role: 'router',
    publishes: TOPICS.routerRouted,
    listens: [TOPICS.pmAllocation, TOPICS.almRebalance],
  });

  process.stdin.resume();
  void stopHeartbeat;
}

async function handleAllocation(
  ctx: AgentContext,
  safeAddress: string,
  intent: AllocationIntent,
): Promise<void> {
  const current = await currentSlices(safeAddress);
  const swaps = decompose(intent, current, PRIMARY_CHAIN);
  if (swaps.length === 0) {
    ctx.log.info('within tolerance — no swaps', { safeAddress });
    return;
  }
  for (const swap of swaps) {
    // The "originIntentId" in our payload would be PM's intent row id;
    // we don't have it on the wire in B-1 (the AllocationIntent shape
    // doesn't carry one). Use the AXL receivedAt as a stable correlator.
    await dispatch({
      ctx,
      safeAddress,
      originIntentId: `pm-${Date.now()}`,
      swap,
    });
  }
}

async function handleRebalance(
  ctx: AgentContext,
  safeAddress: string,
  intent: RebalanceIntent,
): Promise<void> {
  // ALM rebalance intents come in with placeholder token addresses
  // because ALM doesn't decide direction — Router does. For B-1 we
  // forward as a no-op and log; B-2 wires direction-resolution against
  // the v4 PoolManager state ALM already has cached.
  ctx.log.info('alm rebalance received (B-1 stub)', {
    safeAddress,
    poolId: intent.poolId,
    reason: intent.reason,
  });
}

main().catch((err: unknown) => {
  console.error('[router:fatal]', err);
  process.exit(1);
});
