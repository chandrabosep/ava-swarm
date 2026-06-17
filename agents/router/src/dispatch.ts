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

  // Convert USD notional → tokenIn's smallest unit using the live price
  // we got from Zerion. Uniswap's Trading API expects amountIn in token
  // base units (e.g. wei for ETH). Without this conversion the quote
  // returns "no quotes available" because, for an 18-decimal asset, the
  // raw USD-as-microunits value is dust.
  const tokensToSwap = swap.notionalUsd / swap.tokenInPriceUsd;
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
    notionalUsd: swap.notionalUsd,
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
