// Pull portfolio context for a Safe via the Zerion proxy.
//
// We reuse the same Cloudflare Worker proxy the extension uses (no need
// for two API keys floating around). All we need from PM's perspective:
//   - current per-token holdings + USD value
//   - 24h change for risk/momentum signals
//   - chain distribution
//
// Returns a compact Snapshot the LLM prompt can fit into a few hundred
// tokens.

import { env } from '@swarm/shared';

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
