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
 * Resolution: if `lookForMatch` returned a peer advert, this consumes
 * both sides and returns true to mean "settled internally; do NOT
 * dispatch to Uniswap." The actual onchain settlement (wallet-to-
 * wallet transfer through the Permit2 transferFrom whitelist) is the
 * next iteration; for now we record `intent.matched` and let Phase C
 * wire the contract call.
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

  await db().event.create({
    data: {
      walletAddress: ourWallet,
      agent: 'router',
      kind: 'intent.matched',
      payload: {
        advertId: myAdvertId,
        peerAdvertId: peer.advertId,
        peerWallet: peer.walletAddress,
        notionalUsd: mine.notionalUsd,
        savedSlippageEstimate: mine.notionalUsd * 0.0015, // ~15bps Uniswap-typical
      },
    },
  });

  ctx.log.info('OTC matched — settling internally', {
    pair: `${mine.tokenIn}->${mine.tokenOut}`,
    notionalUsd: mine.notionalUsd,
    peerWallet: peer.walletAddress,
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
