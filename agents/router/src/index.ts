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
  db,
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

  // PM allocation inbox — three transports racing for the same intent:
  //   1. AXL gossip   (multi-host production path)
  //   2. PG NOTIFY    (single-host instant path; fastest in dev)
  //   3. DB poll      (resilience fallback, always-on)
  // Whichever delivers first wins via claimIntent() which transitions
  // the row pending→netted in a single SQL statement; losers no-op.
  const claimAndHandle = async (
    transport: 'axl' | 'pg' | 'db-poll',
    safeAddress: string,
    intentId: string | undefined,
    payload: AllocationIntent,
  ) => {
    if (intentId) {
      const claimed = await claimIntent(intentId);
      if (!claimed) return; // another transport got there first
    }
    ctx.log.info(`allocation received via ${transport}`, {
      safeAddress,
      intentId,
    });
    try {
      await handleAllocation(ctx, safeAddress, payload);
    } catch (err) {
      ctx.log.warn('allocation handler failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 1. AXL gossip
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<AllocationIntent>>(
      TOPICS.pmAllocation,
    )) {
      const env = msg.payload;
      if (!env || env.payload?.kind !== 'allocation') continue;
      await claimAndHandle('axl', env.safeAddress, env.intentId, env.payload);
    }
  })();

  // 2. PG LISTEN/NOTIFY — instant cross-process path on a single host
  void (async () => {
    for await (const msg of ctx.pg.subscribe<SwarmMessage<AllocationIntent>>(
      TOPICS.pmAllocation,
    )) {
      const env = msg.payload;
      if (!env || env.payload?.kind !== 'allocation') continue;
      await claimAndHandle('pg', env.safeAddress, env.intentId, env.payload);
    }
  })();

  // 3. DB-poll fallback — claims rows itself via intent-poll; runs even
  //    if AXL and PG are both silent. Fires within the poll cadence.
  startIntentPoll<AllocationIntent>({
    fromAgent: 'pm',
    pendingStatus: 'pending',
    inFlightStatus: 'netted',
    completedStatus: 'netted',
    failedStatus: 'failed',
    log: (level, msg, meta) => ctx.log[level](msg, meta),
    handle: async (row) => {
      if (row.payload?.kind !== 'allocation') return;
      ctx.log.info('allocation received via db-poll', {
        safeAddress: row.safeAddress,
        intentId: row.id,
      });
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

/**
 * Atomically transition an intent row from pending → netted. Returns
 * true if THIS caller won the claim (and therefore should process the
 * intent), false if another transport already claimed it.
 *
 * The single UPDATE...WHERE status='pending' is the dedup primitive
 * for our three-transport delivery model.
 */
async function claimIntent(intentId: string): Promise<boolean> {
  const res = await db().intent.updateMany({
    where: { id: intentId, status: 'pending' },
    data: { status: 'netted' },
  });
  return res.count > 0;
}

main().catch((err: unknown) => {
  console.error('[router:fatal]', err);
  process.exit(1);
});
