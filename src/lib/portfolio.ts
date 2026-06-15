// Helpers that turn raw Zerion position arrays into the dashboard's
// presentation shape (totals, 24h delta, allocation slices). Pure functions
// so they're easy to unit-test if/when we add tests.

import type { AllocationSlice, PortfolioSummary } from '@/types';
import type { ZerionPosition } from '@/types/zerion';

/** How many distinct token slices to show before bucketing the rest as "Other". */
const ALLOCATION_TOP_N = 4;

export function summarizePositions(
  positions: ZerionPosition[],
): PortfolioSummary {
  const valued = positions.filter(
    (p) => (p.attributes.value ?? 0) > 0 && p.attributes.flags.displayable,
  );

  const totalValueUsd = valued.reduce(
    (sum, p) => sum + (p.attributes.value ?? 0),
    0,
  );

  const change24hUsd = valued.reduce(
    (sum, p) => sum + (p.attributes.changes?.absolute_1d ?? 0),
    0,
  );

  // Express the 24h change as a fraction of yesterday's portfolio value
  // (today minus today's delta) so the percentage matches the dollar swing.
  const yesterdayValue = totalValueUsd - change24hUsd;
  const change24hPct =
    yesterdayValue > 0 ? change24hUsd / yesterdayValue : 0;

  const sorted = [...valued].sort(
    (a, b) => (b.attributes.value ?? 0) - (a.attributes.value ?? 0),
  );
  const top = sorted.slice(0, ALLOCATION_TOP_N);
  const rest = sorted.slice(ALLOCATION_TOP_N);
  const restValue = rest.reduce(
    (sum, p) => sum + (p.attributes.value ?? 0),
    0,
  );

  const allocations: AllocationSlice[] = top.map((p) => {
    const value = p.attributes.value ?? 0;
    return {
      symbol: p.attributes.fungible_info.symbol,
      pct: totalValueUsd > 0 ? value / totalValueUsd : 0,
      valueUsd: value,
    };
  });

  if (restValue > 0) {
    allocations.push({
      symbol: 'Other',
      pct: totalValueUsd > 0 ? restValue / totalValueUsd : 0,
      valueUsd: restValue,
    });
  }

  return { totalValueUsd, change24hUsd, change24hPct, allocations };
}

/** Number of distinct chains the wallet has value on. */
export function uniqueChainCount(positions: ZerionPosition[]): number {
  const chains = new Set<string>();
  for (const p of positions) {
    const chainId = p.relationships?.chain?.data.id;
    if (chainId && (p.attributes.value ?? 0) > 0) chains.add(chainId);
  }
  return chains.size;
}
