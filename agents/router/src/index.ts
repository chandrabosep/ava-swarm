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
  startIntentPoll,
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
import {
  broadcastAdvert,
  consumeAdverts,
  lookForMatch,
  settleMatch,
} from './otc.js';

/** Phase B-1: settle every intent on the user's primary chain. Override
 *  with PRIMARY_CHAIN env if you need to demo on a different chain. */
const PRIMARY_CHAIN: SupportedChain =
  (process.env.PRIMARY_CHAIN as SupportedChain | undefined) ?? 'mainnet';

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

  // DB-poll fallback — fires whether or not AXL is up. Same handler as
  // the AXL subscription path; intent-poll claims rows atomically so we
  // can run both without double-processing.
  startIntentPoll<AllocationIntent>({
    fromAgent: 'pm',
    pendingStatus: 'pending',
    inFlightStatus: 'netted',
    completedStatus: 'netted',
    failedStatus: 'failed',
    log: (level, msg, meta) => ctx.log[level](msg, meta),
    handle: async (row) => {
      if (row.payload?.kind !== 'allocation') return;
      await handleAllocation(ctx, row.safeAddress, row.payload);
    },
  });

  // OTC peer advert inbox — runs continuously, attempts cross-tenant matches.
  void consumeAdverts(ctx);

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
    // Try internal OTC match first. If a peer Router on the AXL mesh
    // has an opposing intent at compatible size, settle Safe-to-Safe
    // and skip Uniswap entirely. Falls through to Uniswap if no match
    // surfaces within the advert TTL.
    const peer = lookForMatch(swap, safeAddress);
    if (peer) {
      const advertId = await broadcastAdvert(ctx, swap, safeAddress);
      await settleMatch(
        ctx,
        advertId,
        peer,
        safeAddress as `0x${string}`,
      );
      continue;
    }

    // Broadcast our intent so the next peer with an opposite finds us,
    // then dispatch normally. Atomic-settlement contract for "matched
    // late" advertisements is the next iteration; for now Uniswap
    // handles unmatched volume.
    void broadcastAdvert(ctx, swap, safeAddress);

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
