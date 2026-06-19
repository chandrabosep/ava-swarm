// Dispatch a PairSwap → RoutedIntent on AXL for the Executor.
//
// Phase B-1 always picks Uniswap Trading API as the venue. Phase B-2+
// can quote multiple venues and pick by best-price.

import {
  db,
  env,
  TOPICS,
  type AgentContext,
  type RoutedIntent,
  type SupportedChain,
  type SwarmMessage,
} from '@swarm/shared';

import type { PairSwap } from './decompose.js';
import { TOKENS } from './tokens.js';

const TESTNET_CHAINS: SupportedChain[] = ['sepolia', 'base-sepolia'];

/** Build the set of valid token addresses for a given chain. Pseudo-ETH
 *  (0x000…000) is always valid. Anything else must appear in TOKENS for
 *  that chain. Catches the "sepolia chain + mainnet token address"
 *  inconsistency seen in stale intents. */
function isValidTokenForChain(addr: string, chain: SupportedChain): boolean {
  const lower = addr.toLowerCase();
  if (lower === '0x0000000000000000000000000000000000000000') return true;
  const chainTokens = TOKENS[chain];
  if (!chainTokens) return false;
  return Object.values(chainTokens).some(
    (t) => t.toLowerCase() === lower,
  );
}

export interface DispatchParams {
  ctx: AgentContext;
  walletAddress: string;
  /** Origin intent id this routed swap traces back to. */
  originIntentId: string;
  swap: PairSwap;
}

export async function dispatch(params: DispatchParams): Promise<void> {
  const { ctx, walletAddress, originIntentId, swap } = params;

  // Hard precondition: every routed/event row needs a walletAddress.
  // Anything upstream that slipped through with undefined gets refused
  // here instead of crashing Prisma.
  if (!walletAddress) {
    ctx.log.warn('dispatch refused — missing walletAddress', {
      originIntentId,
      pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
    });
    return;
  }

  // Belt-and-braces guard: if anything upstream tries to dispatch a
  // mainnet swap while USE_TESTNET=true (stale cache, concurrent
  // process holding old code, race during env reload, etc), refuse
  // and log loudly. Trumps any PRIMARY_CHAIN override.
  if (env.useTestnet() && !TESTNET_CHAINS.includes(swap.chain)) {
    ctx.log.error('blocked mainnet dispatch under USE_TESTNET', {
      chain: swap.chain,
      pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
      notionalUsd: swap.notionalUsd,
    });
    return;
  }

  // Address-vs-chain consistency check: refuse to dispatch if either
  // tokenIn or tokenOut isn't a known token on the swap's chain. This
  // catches the case where stale code (or a half-migrated intent)
  // produces a sepolia-labeled swap with mainnet USDC addresses.
  if (
    !isValidTokenForChain(swap.tokenIn, swap.chain) ||
    !isValidTokenForChain(swap.tokenOut, swap.chain)
  ) {
    ctx.log.error('blocked dispatch — token address does not match chain', {
      chain: swap.chain,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
    });
    return;
  }

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
      walletAddress,
      fromAgent: 'router',
      payload: intent as unknown as object,
      status: 'routed',
    },
  });

  await db().event.create({
    data: {
      walletAddress,
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
    walletAddress,
    ts: Date.now(),
    payload: intent,
  };
  await ctx.axl.publish({ topic: TOPICS.routerRouted, payload: msg });
  ctx.log.info('routed', {
    walletAddress,
    pair: `${swap.tokenInSymbol}->${swap.tokenOutSymbol}`,
    notionalUsd: swap.notionalUsd,
    intentId: row.id,
  });
}
