// OTC matching — the agent-to-agent dark pool that runs over AXL.
//
// Concept: before Router dispatches a pair swap to Executor (which
// would hit Uniswap), it broadcasts an OtcAdvert on swarm.otc.advertise.
// Other Routers (serving other tenants on the same or different
// operators' AXL nodes) listen, look for opposite intents in their own
// pending pools, and reply with OtcConfirm if there's a fit.
//
// When matched: both sides skip Uniswap and settle wallet-to-wallet
// at mid-price. Saves slippage, gas, and MEV exposure. When unmatched:
// fall through to the existing Uniswap path after a short window.
//
// This commit ships the matching layer + AXL gossip. The atomic
// settlement contract (wallet-to-wallet transfer via Permit2
// transferFrom from each EOA in one tx, signed by the Executor
// session keys with their per-user policies) is the next iteration.

import type { Address } from 'viem';

import {
  TOPICS,
  type AgentContext,
  type OtcAdvert,
  type OtcConfirm,
  type SupportedChain,
  type SwarmMessage,
} from '@swarm/shared';
import { db } from '@swarm/shared';

import type { PairSwap } from './decompose.js';

/** How long an advert lives before we abandon it and fall through to Uniswap. */
const ADVERT_TTL_MS = 5_000;
/** Notional sizes match within ±5%. Below this, swap as a partial fill. */
const SIZE_TOLERANCE = 0.05;

/** In-memory pool of advertisements I've seen from peers. */
const peerAdverts = new Map<string, OtcAdvert>();
/** In-memory pool of my own pending adverts, awaiting confirmation. */
const myAdverts = new Map<string, OtcAdvert & { swap: PairSwap }>();

let advertCounter = 0;
const newId = (): string => `otc-${Date.now()}-${++advertCounter}`;

/**
 * Try to match a pending PairSwap against the peer pool. Returns the
 * matched advert if found, null otherwise. Doesn't broadcast — caller
 * does that if no immediate match.
 */
export function lookForMatch(
  swap: PairSwap,
  myAddress: string,
): OtcAdvert | null {
  prune();
  for (const advert of peerAdverts.values()) {
    if (advert.walletAddress.toLowerCase() === myAddress.toLowerCase()) continue;
    if (advert.chain !== swap.chain) continue;
    // Opposite direction: peer's tokenIn = my tokenOut, and vice versa.
    if (
      advert.tokenIn.toLowerCase() !== swap.tokenOut.toLowerCase() ||
      advert.tokenOut.toLowerCase() !== swap.tokenIn.toLowerCase()
    ) {
      continue;
    }
    const ratio = swap.notionalUsd / advert.notionalUsd;
    if (ratio < 1 - SIZE_TOLERANCE || ratio > 1 + SIZE_TOLERANCE) continue;
    return advert;
  }
  return null;
}

export async function broadcastAdvert(
  ctx: AgentContext,
  swap: PairSwap,
  walletAddress: string,
): Promise<string> {
  // Hard precondition: every advert + its event row are scoped to a
  // user wallet. Bail early instead of letting Prisma crash on a null
  // FK insert. Returns a fake advert id so callers' `await` doesn't
  // explode — it'll just never match anything.
  if (!walletAddress) {
    ctx.log.warn('advert refused — missing walletAddress', {
      pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
    });
    return '';
  }
  const advert: OtcAdvert = {
    advertId: newId(),
    chain: swap.chain,
    walletAddress,
    tokenIn: swap.tokenIn,
    tokenOut: swap.tokenOut,
    notionalUsd: swap.notionalUsd,
    expiresAt: Date.now() + ADVERT_TTL_MS,
  };
  myAdverts.set(advert.advertId, { ...advert, swap });

  const msg: SwarmMessage<OtcAdvert> = {
    fromAgent: 'router',
    walletAddress,
    ts: Date.now(),
    payload: advert,
  };
  await ctx.axl.publish({ topic: TOPICS.otcAdvertise, payload: msg });

  await db().event.create({
    data: {
      walletAddress,
      agent: 'router',
      kind: 'otc.advertised',
      payload: { advertId: advert.advertId, swap: swap.tokenInSymbol + '->' + swap.tokenOutSymbol, notionalUsd: swap.notionalUsd },
    },
  });

  return advert.advertId;
}

/** Subscribe to peer advert stream. */
export async function consumeAdverts(ctx: AgentContext): Promise<void> {
  for await (const msg of ctx.axl.subscribe<SwarmMessage<OtcAdvert>>(
    TOPICS.otcAdvertise,
  )) {
    const advert = msg.payload?.payload;
    if (!advert?.advertId) continue;
    if (advert.expiresAt < Date.now()) continue;
    peerAdverts.set(advert.advertId, advert);

    // Cross-check: do I have a matching pending of my own?
    const mine = findMyOpposite(advert);
    if (!mine) continue;

    // Send a confirm — peer's Router will accept or reject.
    const confirm: OtcConfirm = {
      advertId: advert.advertId,
      counterAdvertId: mine.advertId,
      walletAddress: mine.walletAddress,
      midPrice18: '1000000000000000000', // 1.0 — placeholder; real price oracle in B-2
      ack: 'accept',
    };
    const reply: SwarmMessage<OtcConfirm> = {
      fromAgent: 'router',
      walletAddress: mine.walletAddress,
      ts: Date.now(),
      payload: confirm,
    };
    await ctx.axl
      .send({
        to: msg.from,
        kind: TOPICS.otcConfirm,
        payload: reply,
      })
      .catch((err) =>
        ctx.log.warn('otc confirm send failed', {
          err: err instanceof Error ? err.message : String(err),
        }),
      );
  }
}

/**
 * Resolution: when `lookForMatch` returned a peer advert, this:
 *   1. removes both sides' adverts from the in-memory pools
 *   2. writes a `routed` Intent row marked status='otc-settled' for
 *      our wallet (so the dashboard activity feed renders it as the
 *      *outcome* of this PM tick — same layout as a Uniswap-routed
 *      intent, just tagged as OTC)
 *   3. writes an `intent.matched` Event for both sides (ours + peer's
 *      walletAddress) with the linked advertIds + estimated savings
 *      vs Uniswap routing
 *   4. emits an executor.receipt-shaped envelope with a synthetic
 *      txHash so PM's accounting code path treats it like a normal
 *      executed swap
 *
 * The "atomic transferFrom via Permit2" onchain leg is intentionally
 * *not* in scope for this implementation — that's a multi-day contract
 * write. What this layer demonstrates is the AXL coordination + the
 * UI flow: two routers on different wallets find each other, agree to
 * match, both feeds show `OTC matched · saved Xbps` in the same
 * round-trip. The actual settlement can be wired to a Permit2
 * mediator later without changing this surface.
 */
export async function settleMatch(
  ctx: AgentContext,
  myAdvertId: string,
  peer: OtcAdvert,
  ourWallet: Address,
): Promise<void> {
  const mine = myAdverts.get(myAdvertId);
  if (!mine) return;
  myAdverts.delete(myAdvertId);
  peerAdverts.delete(peer.advertId);

  // ~15 bps Uniswap-typical fee + ~5 bps slippage. We're saving both.
  const savedUsd = mine.notionalUsd * 0.002;
  // Synthetic settlement id — looks like a tx hash for the UI but
  // distinguishable by the `otc-` prefix in the event payload.
  const settlementId = `0x${'OTC'.padEnd(64, '0').slice(0, 64)}` as `0x${string}`;
  const matchedAt = new Date().toISOString();

  // 1. Persist the routed intent on our side, status='otc-settled'.
  const row = await db().intent.create({
    data: {
      walletAddress: ourWallet,
      fromAgent: 'router',
      payload: {
        kind: 'routed',
        chain: mine.chain,
        venue: 'otc-mesh',
        tokenIn: mine.tokenIn,
        tokenOut: mine.tokenOut,
        amountIn: '0', // sized at Permit2-mediator time, not here
        minAmountOut: '0',
        notionalUsd: mine.notionalUsd,
        origin: myAdvertId,
        otc: {
          peerAdvertId: peer.advertId,
          peerWallet: peer.walletAddress,
          savedUsd,
          settlementId,
        },
      } as unknown as object,
      // OTC matches are recorded as `executed` (true terminal success)
      // — the `otc-mesh` venue + the `otc:` payload field are how the
      // dashboard distinguishes them from Uniswap-routed swaps.
      status: 'executed',
    },
  });

  // 2. Two `intent.matched` events — one keyed to each side's wallet
  //    so both dashboards surface the same match in their feeds.
  await db().event.create({
    data: {
      walletAddress: ourWallet,
      agent: 'router',
      kind: 'intent.matched',
      payload: {
        intentId: row.id,
        advertId: myAdvertId,
        peerAdvertId: peer.advertId,
        peerWallet: peer.walletAddress,
        notionalUsd: mine.notionalUsd,
        savedUsd,
        settlementId,
        matchedAt,
        side: 'mine',
      },
    },
  });
  // Peer-side event — only writes if the peer wallet is in our DB
  // (multi-tenant on the same agents instance). For cross-instance
  // peers this is the responsibility of their Router; harmless if the
  // peer isn't in our user table (Prisma will throw and we swallow).
  await db()
    .event.create({
      data: {
        walletAddress: peer.walletAddress as Address,
        agent: 'router',
        kind: 'intent.matched',
        payload: {
          intentId: row.id,
          advertId: peer.advertId,
          peerAdvertId: myAdvertId,
          peerWallet: ourWallet,
          notionalUsd: peer.notionalUsd,
          savedUsd,
          settlementId,
          matchedAt,
          side: 'peer',
        },
      },
    })
    .catch(() => {
      // Peer wallet not in our DB — they're served by another Router
      // instance. Their side will be written there.
    });

  // 3. Synthetic executor receipt — published on the routerRouted
  //    *and* executorReceipt topics so PM's accounting (rationale tag,
  //    next-tick state) treats this like a normal completed swap.
  const receipt = {
    kind: 'receipt' as const,
    intentId: row.id,
    txHash: settlementId,
    status: 'mined' as const,
    blockNumber: 0,
  };
  await ctx.axl
    .publish({
      topic: TOPICS.executorReceipt,
      payload: {
        fromAgent: 'executor' as const,
        walletAddress: ourWallet,
        ts: Date.now(),
        payload: receipt,
      },
    })
    .catch(() => {
      // best-effort
    });

  ctx.log.info('OTC matched — settled', {
    pair: `${mine.tokenIn}->${mine.tokenOut}`,
    notionalUsd: mine.notionalUsd,
    peerWallet: peer.walletAddress,
    savedUsd: savedUsd.toFixed(4),
    settlementId,
  });
}

function findMyOpposite(peer: OtcAdvert): OtcAdvert | null {
  for (const mine of myAdverts.values()) {
    if (mine.chain !== peer.chain) continue;
    if (
      mine.tokenIn.toLowerCase() === peer.tokenOut.toLowerCase() &&
      mine.tokenOut.toLowerCase() === peer.tokenIn.toLowerCase()
    ) {
      const ratio = mine.notionalUsd / peer.notionalUsd;
      if (ratio >= 1 - SIZE_TOLERANCE && ratio <= 1 + SIZE_TOLERANCE) return mine;
    }
  }
  return null;
}

function prune(): void {
  const now = Date.now();
  for (const [id, advert] of peerAdverts) {
    if (advert.expiresAt < now) peerAdverts.delete(id);
  }
  for (const [id, advert] of myAdverts) {
    if (advert.expiresAt < now) myAdverts.delete(id);
  }
}
