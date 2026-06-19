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
  env,
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
import { preflightEnabled, preflightSwaps } from './preflight.js';

/** Phase B-1: settle every intent on the user's primary chain. Override
 *  with PRIMARY_CHAIN env if you need to demo on a different chain.
 *  When USE_TESTNET=true we HARD-OVERRIDE to a testnet chain even if
 *  PRIMARY_CHAIN was misconfigured to mainnet — shipping mainnet
 *  swaps from a testnet build is the worst kind of footgun and trashes
 *  the dashboard with phantom mainnet rows. */
const TESTNET_CHAINS: SupportedChain[] = ['sepolia', 'base-sepolia'];
const PRIMARY_CHAIN: SupportedChain = (() => {
  const fromEnv = process.env.PRIMARY_CHAIN as SupportedChain | undefined;
  if (env.useTestnet()) {
    // If the env explicitly named a testnet, honor it. Otherwise force sepolia.
    if (fromEnv && TESTNET_CHAINS.includes(fromEnv)) return fromEnv;
    if (fromEnv && !TESTNET_CHAINS.includes(fromEnv)) {
      console.warn(
        `[router] USE_TESTNET=true but PRIMARY_CHAIN=${fromEnv} is a mainnet chain. Forcing 'sepolia'.`,
      );
    }
    return 'sepolia';
  }
  return fromEnv ?? 'mainnet';
})();

async function main() {
  const ctx = await bootAgent('router');
  // Print the resolved settle chain at startup. If you see "mainnet"
  // here under USE_TESTNET=true, my hard-override didn't run — meaning
  // tsx watch is serving stale code. Hard-restart with a fresh
  // `pkill -f tsx`.
  ctx.log.info('chain config', {
    primaryChain: PRIMARY_CHAIN,
    useTestnet: env.useTestnet(),
    primaryChainEnv: process.env.PRIMARY_CHAIN ?? '(unset)',
  });
  const stopHeartbeat = startHeartbeat(ctx);

  // PM allocation inbox — three transports racing for the same intent:
  //   1. AXL gossip   (multi-host production path)
  //   2. PG NOTIFY    (single-host instant path; fastest in dev)
  //   3. DB poll      (resilience fallback, always-on)
  // Whichever delivers first wins via claimIntent() which transitions
  // the row pending→netted in a single SQL statement; losers no-op.
  const claimAndHandle = async (
    transport: 'axl' | 'pg' | 'db-poll',
    walletAddress: string | undefined,
    intentId: string | undefined,
    payload: AllocationIntent,
  ) => {
    // If the gossip envelope is missing walletAddress (older message
    // shape, transport quirk, JSON.stringify dropping `undefined` keys),
    // recover by reading the persisted Intent row — its walletAddress
    // column is non-null by schema, so as long as the publisher wrote
    // the row before notifying we can resync from there.
    if (!walletAddress && intentId) {
      try {
        const row = await db().intent.findUnique({
          where: { id: intentId },
          select: { walletAddress: true },
        });
        if (row?.walletAddress) {
          walletAddress = row.walletAddress;
          ctx.log.info(`allocation walletAddress recovered from DB`, {
            transport,
            intentId,
          });
        }
      } catch (err) {
        ctx.log.warn('walletAddress recovery query failed', {
          intentId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Still nothing — this is a true orphan (no intentId or row gone).
    // Drop quietly so we don't crash Prisma downstream.
    if (!walletAddress) {
      ctx.log.warn('allocation dropped — missing walletAddress', {
        transport,
        intentId,
      });
      return;
    }
    if (intentId) {
      const claimed = await claimIntent(intentId);
      if (!claimed) return; // another transport got there first
    }
    ctx.log.info(`allocation received via ${transport}`, {
      walletAddress,
      intentId,
    });
    try {
      await handleAllocation(ctx, walletAddress, payload);
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
      const envelope = msg.payload;
      if (!envelope || envelope.payload?.kind !== 'allocation') continue;
      await claimAndHandle(
        'axl',
        envelope.walletAddress,
        envelope.intentId,
        envelope.payload,
      );
    }
  })();

  // 2. PG LISTEN/NOTIFY — instant cross-process path on a single host
  void (async () => {
    for await (const msg of ctx.pg.subscribe<SwarmMessage<AllocationIntent>>(
      TOPICS.pmAllocation,
    )) {
      const envelope = msg.payload;
      if (!envelope || envelope.payload?.kind !== 'allocation') continue;
      await claimAndHandle(
        'pg',
        envelope.walletAddress,
        envelope.intentId,
        envelope.payload,
      );
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
        walletAddress: row.walletAddress,
        intentId: row.id,
      });
      await handleAllocation(ctx, row.walletAddress, row.payload);
    },
  });

  // OTC peer advert inbox — runs continuously, attempts cross-tenant matches.
  void consumeAdverts(ctx);

  // ALM rebalance inbox
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<RebalanceIntent>>(
      TOPICS.almRebalance,
    )) {
      const envelope = msg.payload;
      if (!envelope || envelope.payload?.kind !== 'rebalance') continue;
      try {
        await handleRebalance(ctx, envelope.walletAddress, envelope.payload);
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
  walletAddress: string,
  intent: AllocationIntent,
): Promise<void> {
  const current = await currentSlices(walletAddress);
  let swaps = decompose(intent, current, PRIMARY_CHAIN, (msg, meta) =>
    ctx.log.warn(msg, meta),
  );
  if (swaps.length === 0) {
    ctx.log.info('within tolerance — no swaps', { walletAddress });
    return;
  }

  // Pre-flight against the KH wallet — drop swaps it can't supply,
  // resize the rest to the available balance. Default-on under
  // USE_TESTNET so faucet-funded KH wallets stop spamming FAILED
  // chips for swaps that were never feasible.
  if (preflightEnabled()) {
    const pre = await preflightSwaps(swaps, (msg, meta) =>
      ctx.log.info(msg, meta),
    );
    for (const d of pre.dropped) {
      ctx.log.warn('preflight dropped swap', {
        pair: `${d.swap.tokenInSymbol}->${d.swap.tokenOutSymbol}`,
        notionalUsd: d.swap.notionalUsd,
        reason: d.reason,
      });
    }
    swaps = pre.swaps;
    if (swaps.length === 0) {
      ctx.log.info('preflight — no executable swaps', { walletAddress });
      return;
    }
  }

  for (const swap of swaps) {
    // Try internal OTC match first. If a peer Router on the AXL mesh
    // has an opposing intent at compatible size, settle wallet-to-wallet
    // and skip Uniswap entirely. Falls through to Uniswap if no match
    // surfaces within the advert TTL.
    const peer = lookForMatch(swap, walletAddress);
    if (peer) {
      const advertId = await broadcastAdvert(ctx, swap, walletAddress);
      await settleMatch(
        ctx,
        advertId,
        peer,
        walletAddress as `0x${string}`,
      );
      continue;
    }

    // Broadcast our intent so the next peer with an opposite finds us,
    // then dispatch normally. Atomic-settlement contract for "matched
    // late" advertisements is the next iteration; for now Uniswap
    // handles unmatched volume.
    void broadcastAdvert(ctx, swap, walletAddress);

    await dispatch({
      ctx,
      walletAddress,
      originIntentId: `pm-${Date.now()}`,
      swap,
    });
  }
}

async function handleRebalance(
  ctx: AgentContext,
  walletAddress: string,
  intent: RebalanceIntent,
): Promise<void> {
  // ALM rebalance intents come in with placeholder token addresses
  // because ALM doesn't decide direction — Router does. For B-1 we
  // forward as a no-op and log; B-2 wires direction-resolution against
  // the v4 PoolManager state ALM already has cached.
  ctx.log.info('alm rebalance received (B-1 stub)', {
    walletAddress,
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
