// Dispatch a PairSwap → RoutedIntent on AXL for the Executor.
//
// Phase B-1 always picks Uniswap Trading API as the venue. Phase B-2+
// can quote multiple venues and pick by best-price.

import {
  db,
  TOPICS,
  type AgentContext,
  type RoutedIntent,
  type SwarmMessage,
} from '@swarm/shared';

import type { PairSwap } from './decompose.js';

export interface DispatchParams {
  ctx: AgentContext;
  safeAddress: string;
  /** Origin intent id this routed swap traces back to. */
  originIntentId: string;
  swap: PairSwap;
}

export async function dispatch(params: DispatchParams): Promise<void> {
  const { ctx, safeAddress, originIntentId, swap } = params;

  // Cap notional: PM sizes proposals against the user's EOA portfolio,
  // but Executor swaps from the KH-managed wallet which is typically
  // smaller (testnet faucet drops, demo-funded budgets). MAX_SWAP_USD
  // protects against "wrap insufficient ETH" errors when the executing
  // wallet can't cover what PM/Router propose. Defaults to no cap on
  // mainnet; ~250 USD on testnet to fit a 0.3-ETH faucet drop.
  const cap = process.env.MAX_SWAP_USD
    ? parseFloat(process.env.MAX_SWAP_USD)
    : Infinity;
  const cappedNotionalUsd = Math.min(swap.notionalUsd, cap);

  // Convert USD notional → tokenIn's smallest unit using the live price.
  // Uniswap's Trading API expects amountIn in token base units (e.g.
  // wei for ETH).
  const tokensToSwap = cappedNotionalUsd / swap.tokenInPriceUsd;
  const amountInRaw = BigInt(
    Math.floor(tokensToSwap * Math.pow(10, swap.tokenInDecimals)),
  );

  const intent: RoutedIntent = {
    kind: 'routed',
    chain: swap.chain,
    venue: 'uniswap-trade-api',
    tokenIn: swap.tokenIn,
    tokenOut: swap.tokenOut,
    amountIn: amountInRaw.toString(),
    minAmountOut: '0', // Executor enforces via Uniswap's minOut on /quote
    notionalUsd: cappedNotionalUsd,
    origin: originIntentId,
  };

  const row = await db().intent.create({
    data: {
      safeAddress,
      fromAgent: 'router',
      payload: intent as unknown as object,
      status: 'routed',
    },
  });

  await db().event.create({
    data: {
      safeAddress,
      agent: 'router',
      kind: 'intent.routed',
      payload: {
        intentId: row.id,
        origin: originIntentId,
        pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
        notionalUsd: swap.notionalUsd,
      },
    },
  });

  const msg: SwarmMessage<RoutedIntent> = {
    fromAgent: 'router',
    safeAddress,
    ts: Date.now(),
    payload: intent,
  };
  await ctx.axl.publish({ topic: TOPICS.routerRouted, payload: msg });
  ctx.log.info('routed', {
    safeAddress,
    pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
    notionalUsd: swap.notionalUsd,
    intentId: row.id,
  });
}
