// Same portfolio helper PM uses, narrowed to what Router needs:
// the user's current per-symbol USD holdings AND a derived USD price so
// the Executor can convert USD notional → token amount in smallest unit
// when calling Uniswap.
//
// Source: Zerion on mainnets (where it's indexed), Alchemy on testnets
// (Zerion doesn't cover Sepolia/Base Sepolia). Toggled by USE_TESTNET.
//
// Reads from the KH-managed wallet, not the user's EOA — same reason
// as PM (see agents/pm/src/portfolio.ts header). Router's deltas need
// to match what KH can actually transferFrom. Override with
// PM_PORTFOLIO_FROM=eoa for the EIP-7702 path.

import {
  env,
  fetchAlchemyTokens,
  alchemyBalanceFloat,
  alchemyUsdPrice,
} from '@swarm/shared';
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

/** Same selector PM uses — reads KH wallet by default, user EOA when
 *  PM_PORTFOLIO_FROM=eoa. Keeps Router's view of "current holdings"
 *  aligned with what Executor can actually pull from. */
function effectiveWallet(userEoa: string): string {
  const mode = (process.env.PM_PORTFOLIO_FROM ?? 'kh').toLowerCase();
  if (mode === 'eoa') return userEoa;
  return process.env.KEEPERHUB_WALLET_ADDRESS ?? userEoa;
}

export async function currentSlices(wallet: string): Promise<CurrentSlice[]> {
  const target = effectiveWallet(wallet);
  if (env.useTestnet()) {
    return currentSlicesAlchemy(target);
  }
  return currentSlicesZerion(target);
}

/** Map raw symbol → canonical bucket. WETH collapses into ETH because
 *  PM only proposes "ETH" targets — keeping them separate makes Router
 *  emit phantom WETH→USDC swaps for any orphan WETH balance, which KH
 *  can rarely fulfill. They're economically equivalent (1:1 wrap), so
 *  treat them as one slice. Same for any future canonical merges. */
function canonicalSymbol(sym: string): Symbol | null {
  const upper = sym.toUpperCase();
  if (upper === 'WETH') return 'ETH';
  if ((['ETH', 'WBTC', 'USDC', 'UNI'] as const).includes(upper as Symbol)) {
    return upper as Symbol;
  }
  return null;
}

async function currentSlicesAlchemy(wallet: string): Promise<CurrentSlice[]> {
  const tokens = await fetchAlchemyTokens(wallet.toLowerCase());
  // Aggregate across networks (a user might hold WETH on multiple chains).
  interface Acc {
    valueUsd: number;
    quantity: number;
    decimals: number;
  }
  const map = new Map<Symbol, Acc>();
  for (const t of tokens) {
    if (t.error) continue;
    const rawSym = t.tokenMetadata?.symbol ?? '';
    // Native tokens come back without a metadata.symbol on some chains —
    // a null tokenAddress means it's the chain's native asset, which we
    // treat as ETH for our universe.
    const effectiveRaw =
      t.tokenAddress === null && !rawSym ? 'ETH' : rawSym;
    const effectiveSym = canonicalSymbol(effectiveRaw);
    if (!effectiveSym) continue;
    const qty = alchemyBalanceFloat(t);
    const priceUsd = alchemyUsdPrice(t);
    const decimals = t.tokenMetadata?.decimals ?? defaultDecimals(effectiveSym);
    const valueUsd = qty * priceUsd;
    const cur = map.get(effectiveSym) ?? {
      valueUsd: 0,
      quantity: 0,
      decimals,
    };
    cur.valueUsd += valueUsd;
    cur.quantity += qty;
    cur.decimals = Math.max(cur.decimals, decimals);
    map.set(effectiveSym, cur);
  }
  return Array.from(map.entries()).map(([symbol, acc]) => ({
    symbol,
    valueUsd: acc.valueUsd,
    priceUsd:
      acc.quantity > 0 ? acc.valueUsd / acc.quantity : fallbackPrice(symbol),
    decimals: acc.decimals,
  }));
}

async function currentSlicesZerion(wallet: string): Promise<CurrentSlice[]> {
  const url = `${env.zerionProxyUrl()}/wallets/${wallet.toLowerCase()}/positions/?currency=usd&filter[positions]=only_simple&filter[trash]=only_non_trash&sort=-value`;
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
    const sym = canonicalSymbol(p.attributes.fungible_info.symbol);
    if (!sym) continue;
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
