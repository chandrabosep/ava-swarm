// Same Zerion-snapshot helper PM uses, narrowed to what Router needs:
// the user's current per-symbol USD holdings AND a derived USD price so
// the Executor can convert USD notional → token amount in smallest unit
// when calling Uniswap.

import { env } from '@swarm/shared';
import type { Symbol } from './tokens.js';
import type { CurrentSlice } from './decompose.js';

interface ZerionPositionsResponse {
  data: Array<{
    attributes: {
      value: number | null;
      quantity?: {
        numeric?: string;
        decimals?: number;
      } | null;
      fungible_info: {
        symbol: string;
        implementations?: Array<{
          chain_id: string;
          decimals: number;
          address?: string | null;
        }>;
      };
    };
  }>;
}

const ALLOWED: Symbol[] = ['ETH', 'WETH', 'WBTC', 'USDC', 'UNI'];

export async function currentSlices(safe: string): Promise<CurrentSlice[]> {
  const url = `${env.zerionProxyUrl()}/wallets/${safe.toLowerCase()}/positions/?currency=usd&filter[positions]=only_simple&filter[trash]=only_non_trash&sort=-value`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zerion ${res.status}`);
  const json = (await res.json()) as ZerionPositionsResponse;

  // Aggregate USD value AND quantity per symbol so we can derive a
  // price (USD per whole token). Zerion may return the same symbol
  // across multiple chains; we sum values + quantities and pick the
  // largest single decimals reading we see.
  interface Acc {
    valueUsd: number;
    quantity: number;
    decimals: number;
  }
  const map = new Map<Symbol, Acc>();
  for (const p of json.data) {
    const sym = p.attributes.fungible_info.symbol as Symbol;
    if (!ALLOWED.includes(sym)) continue;
    const value = p.attributes.value ?? 0;
    const qty = parseFloat(p.attributes.quantity?.numeric ?? '0') || 0;
    const dec =
      p.attributes.quantity?.decimals ??
      p.attributes.fungible_info.implementations?.[0]?.decimals ??
      defaultDecimals(sym);
    const cur = map.get(sym) ?? { valueUsd: 0, quantity: 0, decimals: dec };
    cur.valueUsd += value;
    cur.quantity += qty;
    cur.decimals = Math.max(cur.decimals, dec);
    map.set(sym, cur);
  }

  return Array.from(map.entries()).map(([symbol, acc]) => ({
    symbol,
    valueUsd: acc.valueUsd,
    // Avoid div-by-zero when a symbol exists at 0 quantity (Zerion
    // sometimes returns zero-balance positions). Fall back to a sane
    // default so the route still produces a positive amountIn.
    priceUsd:
      acc.quantity > 0 ? acc.valueUsd / acc.quantity : fallbackPrice(symbol),
    decimals: acc.decimals,
  }));
}

function defaultDecimals(sym: Symbol): number {
  if (sym === 'WBTC') return 8;
  if (sym === 'USDC') return 6;
  return 18;
}

/**
 * Coarse fallback prices so the Executor can still build a quote when
 * Zerion returns a position without a usable quantity. Updated 2026
 * Q1 ballpark — replace with a live oracle when accuracy matters.
 */
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
    default:
      return 1;
  }
}
