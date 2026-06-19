// Alchemy Portfolio API client for the dashboard — used as a Zerion
// replacement when USE_TESTNET is on (Zerion doesn't index Sepolia or
// Base Sepolia).
//
// Returns shapes structurally compatible with what zerion.ts produces
// so the rest of the UI (`summarizePositions`, the allocation breakdown,
// etc.) doesn't need to branch.

import { ALCHEMY_API_KEY, ALCHEMY_NETWORKS } from '@/config/swarm';
import type {
  ZerionPosition,
  ZerionPositionsResponse,
  ZerionPortfolioResponse,
} from '@/types/zerion';

const BASE_URL = 'https://api.g.alchemy.com/data/v1';

interface AlchemyToken {
  network: string;
  address: string;
  tokenAddress: string | null;
  tokenBalance: string;
  tokenMetadata?: {
    decimals?: number;
    logo?: string | null;
    name?: string;
    symbol?: string;
  };
  tokenPrices?: Array<{ currency: string; value: string; lastUpdatedAt: string }>;
  error?: string | null;
}

interface AlchemyTokensResponse {
  data: { tokens: AlchemyToken[] };
}

/**
 * Coarse mainnet-equivalent prices for testnet tokens. Alchemy doesn't
 * return prices for testnet rows, so we synthesize them from a small
 * symbol map — same approach the agents take. Override per-symbol via
 * VITE_TESTNET_PRICE_<SYMBOL>.
 */
function fallbackPrice(symbol?: string): number {
  if (!symbol) return 0;
  const sym = symbol.toUpperCase();
  const o = (import.meta.env as Record<string, string | undefined>)[
    `VITE_TESTNET_PRICE_${sym}`
  ];
  if (o) return parseFloat(o);
  switch (sym) {
    case 'ETH':
    case 'WETH':
      return 3000;
    case 'WBTC':
    case 'BTC':
      return 60000;
    case 'USDC':
    case 'USDT':
    case 'DAI':
      return 1;
    case 'UNI':
      return 8;
    default:
      return 0;
  }
}

async function fetchAlchemyTokens(wallet: string): Promise<AlchemyToken[]> {
  const url = `${BASE_URL}/${ALCHEMY_API_KEY}/assets/tokens/by-address`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      addresses: [{ address: wallet, networks: ALCHEMY_NETWORKS }],
      withMetadata: true,
      withPrices: true,
      includeNativeTokens: true,
      includeErc20Tokens: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alchemy ${res.status} ${res.statusText}: ${body}`);
  }
  const json = (await res.json()) as AlchemyTokensResponse;
  return json.data?.tokens ?? [];
}

function alchemyToZerionPosition(t: AlchemyToken): ZerionPosition | null {
  const dec = t.tokenMetadata?.decimals ?? 18;
  let raw: bigint;
  try {
    raw = BigInt(t.tokenBalance);
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  const div = 10n ** BigInt(dec);
  const whole = raw / div;
  const frac = raw % div;
  const balance = parseFloat(`${whole}.${frac.toString().padStart(dec, '0')}`);
  // Canonicalize: every chain's native asset is rendered as ETH so the
  // allocation chart aggregates Sepolia + Base Sepolia native balances
  // into a single ETH row instead of showing two separate "ETH" entries.
  // Same for stablecoins that some chains label differently.
  const rawSym = (
    t.tokenMetadata?.symbol ??
    (t.tokenAddress === null ? 'ETH' : '')
  ).toUpperCase();
  const symbol =
    t.tokenAddress === null
      ? 'ETH'
      : rawSym === 'USDBC' || rawSym === 'USDCE'
        ? 'USDC'
        : rawSym || 'UNKNOWN';
  const usd = t.tokenPrices?.find((p) => p.currency.toLowerCase() === 'usd');
  const price = usd ? parseFloat(usd.value) : fallbackPrice(symbol);
  const value = balance * price;
  return {
    type: 'positions',
    id: `alchemy:${t.network}:${t.tokenAddress ?? 'native'}`,
    attributes: {
      name: t.tokenMetadata?.name ?? symbol,
      quantity: {
        int: t.tokenBalance,
        decimals: dec,
        float: balance,
        numeric: String(balance),
      },
      value,
      price,
      changes: null, // Alchemy doesn't return 24h delta on this endpoint.
      fungible_info: {
        name: t.tokenMetadata?.name ?? symbol,
        symbol,
        icon: t.tokenMetadata?.logo
          ? { url: t.tokenMetadata.logo }
          : { url: null },
        implementations: [
          {
            chain_id: t.network,
            address: t.tokenAddress,
            decimals: dec,
          },
        ],
      },
      flags: { displayable: true, is_trash: false },
      position_type: 'wallet',
    },
    relationships: {
      chain: { data: { type: 'chains', id: t.network } },
    },
  };
}

/** Drop-in replacement for `getFungiblePositions` that hits Alchemy.
 *  Rolls up positions by SYMBOL so ETH-on-sepolia and ETH-on-base-sepolia
 *  combine into a single ETH row — matches what users expect to see in
 *  the allocation chart, and avoids React-key collisions downstream. */
export async function getAlchemyPositions(
  address: string,
): Promise<ZerionPositionsResponse> {
  const raw = await fetchAlchemyTokens(address.toLowerCase());
  const positions = raw
    .map(alchemyToZerionPosition)
    .filter((p): p is ZerionPosition => p !== null);

  // Aggregate by symbol — sum balances + USD values, keep first chain's
  // metadata, generate a stable id from the symbol for React keys.
  const bySymbol = new Map<string, ZerionPosition>();
  for (const p of positions) {
    const sym = p.attributes.fungible_info.symbol;
    const existing = bySymbol.get(sym);
    if (!existing) {
      bySymbol.set(sym, { ...p, id: `alchemy:agg:${sym}` });
      continue;
    }
    const ev = existing.attributes.value ?? 0;
    const pv = p.attributes.value ?? 0;
    const eq = existing.attributes.quantity.float;
    const pq = p.attributes.quantity.float;
    const totalQ = eq + pq;
    existing.attributes.value = ev + pv;
    existing.attributes.quantity = {
      ...existing.attributes.quantity,
      float: totalQ,
      numeric: String(totalQ),
    };
    // Merge implementations so the symbol resolves on either chain
    existing.attributes.fungible_info.implementations = [
      ...existing.attributes.fungible_info.implementations,
      ...p.attributes.fungible_info.implementations,
    ];
  }
  return { data: Array.from(bySymbol.values()) };
}

/** Drop-in replacement for `getWalletPortfolio`. We fold Alchemy rows
 *  up by network for the chain-distribution chart. */
export async function getAlchemyPortfolio(
  address: string,
): Promise<ZerionPortfolioResponse> {
  const tokens = await fetchAlchemyTokens(address.toLowerCase());
  let walletUsd = 0;
  const byChain: Record<string, number> = {};
  for (const t of tokens) {
    if (t.error) continue;
    const dec = t.tokenMetadata?.decimals ?? 18;
    let raw: bigint;
    try {
      raw = BigInt(t.tokenBalance);
    } catch {
      continue;
    }
    if (raw <= 0n) continue;
    const div = 10n ** BigInt(dec);
    const balance = Number(raw / div) + Number(raw % div) / Number(div);
    const symbol =
      t.tokenMetadata?.symbol ?? (t.tokenAddress === null ? 'ETH' : 'X');
    const usd = t.tokenPrices?.find((p) => p.currency.toLowerCase() === 'usd');
    const price = usd ? parseFloat(usd.value) : fallbackPrice(symbol);
    const value = balance * price;
    walletUsd += value;
    byChain[t.network] = (byChain[t.network] ?? 0) + value;
  }
  return {
    data: {
      type: 'portfolios',
      id: address.toLowerCase(),
      attributes: {
        positions_distribution_by_type: {
          wallet: walletUsd,
          deposited: 0,
          borrowed: 0,
          locked: 0,
          staked: 0,
        },
        positions_distribution_by_chain: byChain,
        total: { positions: walletUsd },
        changes: { absolute_1d: 0, percent_1d: 0 },
      } as ZerionPortfolioResponse['data']['attributes'],
    } as ZerionPortfolioResponse['data'],
  };
}
