// React Query hooks over the Zerion client.
//
// Caching strategy is set globally in main.tsx (PersistQueryClientProvider
// + 5-minute staleTime + no auto-refetch). These hooks just declare the
// queryKey/queryFn pair; refetch policy lives at the provider level so all
// queries share it.
//
// Why no refetchInterval here? Zerion's Demo plan is 300 req/day. With
// three endpoints and minute-interval polling, one tab open for an hour is
// 180 requests. Manual refresh via `refetch()` is the right model.

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import {
  getFungiblePositions,
  getWalletPnl,
  getWalletPortfolio,
  getWalletTransactions,
  ZerionError,
  type PositionsQuery,
  type TransactionsQuery,
} from '@/lib/zerion';
import {
  getAlchemyPositions,
  getAlchemyPortfolio,
} from '@/lib/alchemy';
import { USE_TESTNET } from '@/config/swarm';
import { recordSnapshot } from '@/lib/portfolioSnapshots';
import { stableUsdFromPortfolio } from '@/lib/portfolio';

/** Don't retry 429s — they only get worse the more we hit them. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ZerionError && error.status === 429) return false;
  return failureCount < 1;
}

export function useFungiblePositions(query: PositionsQuery = {}) {
  const { address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  return useQuery({
    queryKey: [
      USE_TESTNET ? 'alchemy' : 'zerion',
      'positions',
      lowerAddress,
      query,
    ],
    queryFn: () =>
      USE_TESTNET
        ? getAlchemyPositions(address!)
        : getFungiblePositions(address!, query),
    enabled: !!address,
    retry: shouldRetry,
  });
}

export function useWalletPortfolio(currency: string = 'usd') {
  const { address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  const query = useQuery({
    queryKey: [
      USE_TESTNET ? 'alchemy' : 'zerion',
      'portfolio',
      lowerAddress,
      currency,
    ],
    queryFn: () =>
      USE_TESTNET
        ? getAlchemyPortfolio(address!)
        : getWalletPortfolio(address!, currency),
    enabled: !!address,
    retry: shouldRetry,
  });

  // Persist a {ts, totalUsd, stablesUsd} sample whenever we land a fresh
  // payload. Drives the interval-Change card downstream — neither
  // Zerion nor Alchemy gives us sub-24h history, so we have to keep our
  // own. The stables figure is best-effort: on testnet (Alchemy path)
  // the synthetic portfolio response doesn't break it down, so we lean
  // on the positions feed via a sibling hook (SummaryCards passes it in).
  useEffect(() => {
    if (!lowerAddress || !query.data) return;
    const totalUsd = query.data.data.attributes.total.positions ?? 0;
    if (totalUsd <= 0) return;
    // We don't have positions here, just totals. stablesUsd resolution
    // happens at render time inside SummaryCards via stableUsdFromPortfolio
    // when positions are known. Snapshot now with stablesUsd=0 as a
    // placeholder; SummaryCards re-records once positions arrive (the
    // 30s dedupe inside recordSnapshot keeps both records collapsed
    // into one entry).
    recordSnapshot(lowerAddress, totalUsd, 0);
  }, [lowerAddress, query.dataUpdatedAt, query.data]);

  return query;
}

// Re-export so SummaryCards can import via the hook layer if it wants.
export { stableUsdFromPortfolio };

export function useWalletTransactions(query: TransactionsQuery = {}) {
  const { address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  return useQuery({
    queryKey: ['zerion', 'transactions', lowerAddress, query],
    queryFn: () => getWalletTransactions(address!, query),
    enabled: !!address,
    retry: shouldRetry,
  });
}

export function useWalletPnl(currency: string = 'usd') {
  const { address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  return useQuery({
    queryKey: ['zerion', 'pnl', lowerAddress, currency],
    queryFn: () => getWalletPnl(address!, currency),
    enabled: !!address,
    retry: shouldRetry,
  });
}
