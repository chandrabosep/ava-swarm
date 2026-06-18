// Alchemy Portfolio API client — used as a Zerion replacement when
// USE_TESTNET=true (Zerion doesn't index testnets).
//
// One POST call to /assets/tokens/by-address returns balances +
// metadata + USD prices for every wallet/network pair we ask for, so
// PM and Router can build their snapshots from a single response
// (same shape they already get from Zerion, just sourced differently).
//
// Reference:
//   https://www.alchemy.com/docs/data/portfolio-apis/portfolio-api-endpoints/portfolio-api-endpoints/get-tokens-by-address

import { env } from './env.js';

const BASE_URL = 'https://api.g.alchemy.com/data/v1';

export interface AlchemyToken {
  /** Network identifier like "eth-sepolia". */
  network: string;
  /** Wallet address (lowercased). */
  address: string;
  /** Token contract address; null = native (ETH/MATIC/etc). */
  tokenAddress: string | null;
  /** Hex-string balance in smallest units (wei for 18-decimal tokens). */
  tokenBalance: string;
  tokenMetadata?: {
    decimals?: number;
    logo?: string | null;
    name?: string;
    symbol?: string;
  };
  tokenPrices?: Array<{
    currency: string;
    value: string;
    lastUpdatedAt: string;
  }>;
  error?: string | null;
}

interface AlchemyTokensResponse {
  data: {
    tokens: AlchemyToken[];
    pageKey?: string;
  };
}

/**
 * Fetch every fungible token (native + ERC-20) the given wallet holds
 * across the configured Alchemy networks, with metadata and USD prices
 * inlined. Empty `networks` falls back to `env.alchemyNetworks()`.
 */
export async function fetchAlchemyTokens(
  wallet: string,
  networks?: string[],
): Promise<AlchemyToken[]> {
  const apiKey = env.alchemyApiKey();
  const nets = networks?.length ? networks : env.alchemyNetworks();
  const url = `${BASE_URL}/${apiKey}/assets/tokens/by-address`;
  const body = {
    addresses: [{ address: wallet, networks: nets }],
    withMetadata: true,
    withPrices: true,
    includeNativeTokens: true,
    includeErc20Tokens: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Alchemy ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as AlchemyTokensResponse;
  return json.data?.tokens ?? [];
}

/**
 * Coarse mainnet-equivalent prices for testnet tokens — Alchemy returns
 * `tokenPrices: []` for Sepolia/Base Sepolia (no real markets), so we
 * fall back to these hardcoded values so the swarm can still compute a
 * portfolio total. Override with TESTNET_PRICE_<SYMBOL> if needed.
 */
function symbolFallbackPrice(symbol?: string): number {
  if (!symbol) return 0;
  const sym = symbol.toUpperCase();
  const envOverride = process.env[`TESTNET_PRICE_${sym}`];
  if (envOverride) return parseFloat(envOverride);
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

/** USD value for a token row. Uses Alchemy's price when present; falls
 *  back to a hardcoded mainnet-equivalent for known symbols (so testnet
 *  rollups still produce a non-zero portfolio total). */
export function alchemyUsdPrice(t: AlchemyToken): number {
  const usd = t.tokenPrices?.find((p) => p.currency.toLowerCase() === 'usd');
  if (usd) return parseFloat(usd.value);
  // No price — synthesize one from the symbol (testnet path).
  const sym = t.tokenMetadata?.symbol ??
    (t.tokenAddress === null ? 'ETH' : undefined);
  return symbolFallbackPrice(sym);
}

/** Decimal-aware float balance. */
export function alchemyBalanceFloat(t: AlchemyToken): number {
  const dec = t.tokenMetadata?.decimals ?? 18;
  const raw = BigInt(t.tokenBalance);
  // Convert via string to avoid Number precision loss for big tokens.
  const div = 10n ** BigInt(dec);
  const whole = raw / div;
  const frac = raw % div;
  return parseFloat(`${whole}.${frac.toString().padStart(dec, '0')}`);
}
