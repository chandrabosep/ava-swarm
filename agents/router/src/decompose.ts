// Decompose an AllocationIntent into a list of per-pair swap intents.
//
// Logic: for each (current, target) weight pair, compute the USD delta.
// If |delta| > toleranceBps × totalValue, emit a swap. Sort sells before
// buys so the executor can free up the right tokens before spending them.
//
// Cross-token netting (sell A, buy B → swap A→B) is the simplest version:
// we pair the largest sell with the largest buy, then iterate. This isn't
// minimum-cost routing but it's good enough for Phase B-1 — Phase B-2+
// can plug in a proper LP solver here.

import type { AllocationIntent, SupportedChain } from '@swarm/shared';
import { resolve, type Symbol } from './tokens.js';

export interface PairSwap {
  chain: SupportedChain;
  tokenInSymbol: Symbol;
  tokenOutSymbol: Symbol;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  /** USD value being moved. */
  notionalUsd: number;
  /** USD per whole tokenIn (e.g. ETH at $3,000 → 3000). Used by dispatch
   *  to compute the on-wire amountIn in tokenIn's smallest unit. */
  tokenInPriceUsd: number;
  /** Decimals for tokenIn (18 for ETH/WETH/UNI, 8 for WBTC, 6 for USDC). */
  tokenInDecimals: number;
}

export interface CurrentSlice {
  symbol: Symbol;
  /** USD value currently held. */
  valueUsd: number;
  /** USD per whole token (USD value ÷ token quantity). */
  priceUsd: number;
  /** Token decimals. */
  decimals: number;
}

export function decompose(
  allocation: AllocationIntent,
  current: CurrentSlice[],
  /** Where to settle. Phase B-1 always picks the user's primary chain. */
  chain: SupportedChain,
): PairSwap[] {
  const total = current.reduce((s, c) => s + c.valueUsd, 0);
  if (total === 0) return [];

  const tolerance = ((allocation.toleranceBps ?? 0) / 10_000) * total;

  // Compute USD delta per symbol — positive = we want to acquire, negative = we want to sell.
  const targetMap = new Map(allocation.targets.map((t) => [t.symbol, t.weight]));
  const currentMap = new Map(current.map((c) => [c.symbol, c]));
  const symbols = new Set<string>([
    ...targetMap.keys(),
    ...current.map((c) => c.symbol),
  ]);

  const deltas: {
    symbol: Symbol;
    usd: number;
    priceUsd: number;
    decimals: number;
  }[] = [];
  for (const sym of symbols) {
    const targetWeight = targetMap.get(sym) ?? 0;
    const slice = currentMap.get(sym as Symbol);
    const currentValue = slice?.valueUsd ?? 0;
    const usd = targetWeight * total - currentValue;
    if (Math.abs(usd) > tolerance) {
      deltas.push({
        symbol: sym as Symbol,
        usd,
        priceUsd: slice?.priceUsd ?? fallbackPrice(sym as Symbol),
        decimals: slice?.decimals ?? defaultDecimals(sym as Symbol),
      });
    }
  }

  // Pair largest sell with largest buy until one side is exhausted.
  const sells = deltas.filter((d) => d.usd < 0).map((d) => ({ ...d, usd: -d.usd }));
  const buys = deltas.filter((d) => d.usd > 0);
  sells.sort((a, b) => b.usd - a.usd);
  buys.sort((a, b) => b.usd - a.usd);

  const swaps: PairSwap[] = [];
  while (sells.length > 0 && buys.length > 0) {
    const sell = sells[0];
    const buy = buys[0];
    const notional = Math.min(sell.usd, buy.usd);

    swaps.push({
      chain,
      tokenInSymbol: sell.symbol,
      tokenOutSymbol: buy.symbol,
      tokenIn: resolve(sell.symbol, chain),
      tokenOut: resolve(buy.symbol, chain),
      notionalUsd: notional,
      tokenInPriceUsd: sell.priceUsd,
      tokenInDecimals: sell.decimals,
    });

    sell.usd -= notional;
    buy.usd -= notional;
    if (sell.usd <= 0.01) sells.shift();
    if (buy.usd <= 0.01) buys.shift();
  }

  return swaps;
}

function fallbackPrice(sym: Symbol): number {
  switch (sym) {
    case 'ETH':
    case 'WETH':
      return 3000;
    case 'WBTC':
      return 60000;
    case 'USDC':
      return 1;
    case 'UNI':
      return 8;
  }
}

function defaultDecimals(sym: Symbol): number {
  if (sym === 'WBTC') return 8;
  if (sym === 'USDC') return 6;
  return 18;
}
