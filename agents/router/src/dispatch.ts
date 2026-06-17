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

  // Quote-driven amountIn would be ideal, but Trading API does that work
  // when Executor calls /quote — we just hand it the USD notional and
  // let it convert to base units. Encode notional as the amountIn for
  // now; Executor's quote step decodes.
  const intent: RoutedIntent = {
    kind: 'routed',
    chain: swap.chain,
    venue: 'uniswap-trade-api',
    tokenIn: swap.tokenIn,
    tokenOut: swap.tokenOut,
    amountIn: String(Math.round(swap.notionalUsd * 1_000_000)), // 6-dec USD
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
