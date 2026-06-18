// Pull portfolio context for a Safe.
//
// Mainnet: Zerion proxy (same Cloudflare Worker the extension uses).
// Testnet: Alchemy Portfolio API (Zerion doesn't index Sepolia/etc).
// Toggled by USE_TESTNET in the env.
//
// Returns a compact Snapshot the LLM prompt can fit into a few hundred
// tokens. 24h change is filled from Zerion when available; on testnet
// we leave it at 0 (Alchemy doesn't ship 24h deltas in this endpoint).

import {
  env,
  fetchAlchemyTokens,
  alchemyBalanceFloat,
  alchemyUsdPrice,
} from '@swarm/shared';

export interface PositionSlice {
  symbol: string;
  chain?: string;
  valueUsd: number;
  /** Fraction of portfolio (0..1). */
  weight: number;
  change24hPct: number;
}

export interface PortfolioSnapshot {
  totalValueUsd: number;
  change24hUsd: number;
  change24hPct: number;
  positions: PositionSlice[];
}

interface ZerionPortfolioResponse {
  data: {
    attributes: {
      total: { positions: number };
      changes: { absolute_1d: number; percent_1d: number };
      positions_distribution_by_chain: Record<string, number>;
    };
  };
}

interface ZerionPositionsResponse {
  data: Array<{
    attributes: {
      value: number | null;
      changes: { percent_1d: number } | null;
      fungible_info: { symbol: string };
    };
    relationships?: { chain?: { data: { id: string } } };
  }>;
}

const TOP_N_POSITIONS = 10;

export async function snapshot(safe: string): Promise<PortfolioSnapshot> {
  if (env.useTestnet()) {
    return snapshotAlchemy(safe);
  }
  return snapshotZerion(safe);
}

async function snapshotAlchemy(safe: string): Promise<PortfolioSnapshot> {
  const tokens = await fetchAlchemyTokens(safe.toLowerCase());
  // Roll positions up by symbol+network so the LLM gets one row per
  // distinct holding (mirrors what Zerion's positions endpoint does).
  const rows: PositionSlice[] = [];
  for (const t of tokens) {
    if (t.error) continue;
    const symbol = t.tokenMetadata?.symbol ??
      (t.tokenAddress === null ? 'ETH' : 'UNKNOWN');
    const qty = alchemyBalanceFloat(t);
    const priceUsd = alchemyUsdPrice(t);
    const valueUsd = qty * priceUsd;
    if (valueUsd <= 0) continue;
    rows.push({
      symbol,
      chain: t.network,
      valueUsd,
      weight: 0, // filled below
      change24hPct: 0, // Alchemy's tokens-by-address doesn't return 24h
    });
  }
  rows.sort((a, b) => b.valueUsd - a.valueUsd);
  const topRows = rows.slice(0, TOP_N_POSITIONS);
  const totalValueUsd = topRows.reduce((s, p) => s + p.valueUsd, 0);
  for (const r of topRows) {
    r.weight = totalValueUsd > 0 ? r.valueUsd / totalValueUsd : 0;
  }
  return {
    totalValueUsd,
    change24hUsd: 0,
    change24hPct: 0,
    positions: topRows,
  };
}

async function snapshotZerion(safe: string): Promise<PortfolioSnapshot> {
  const base = env.zerionProxyUrl();
  const safeLc = safe.toLowerCase();
  const [pf, pos] = await Promise.all([
    fetchJson<ZerionPortfolioResponse>(
      `${base}/wallets/${safeLc}/portfolio?currency=usd`,
    ),
    fetchJson<ZerionPositionsResponse>(
      `${base}/wallets/${safeLc}/positions/?currency=usd&filter[positions]=only_simple&filter[trash]=only_non_trash&sort=-value`,
    ),
  ]);

  const totalValueUsd = pf.data.attributes.total.positions;
  const change24hUsd = pf.data.attributes.changes.absolute_1d;
  const change24hPct = pf.data.attributes.changes.percent_1d;

  const positions: PositionSlice[] = pos.data
    .filter((p) => (p.attributes.value ?? 0) > 0)
    .slice(0, TOP_N_POSITIONS)
    .map((p) => ({
      symbol: p.attributes.fungible_info.symbol,
      chain: p.relationships?.chain?.data.id,
      valueUsd: p.attributes.value ?? 0,
      weight:
        totalValueUsd > 0 ? (p.attributes.value ?? 0) / totalValueUsd : 0,
      change24hPct: p.attributes.changes?.percent_1d ?? 0,
    }));

  return { totalValueUsd, change24hUsd, change24hPct, positions };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zerion ${res.status}: ${url}`);
  return (await res.json()) as T;
}
