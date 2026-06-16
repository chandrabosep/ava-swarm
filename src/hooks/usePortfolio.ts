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

/** Don't retry 429s — they only get worse the more we hit them. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ZerionError && error.status === 429) return false;
  return failureCount < 1;
}

export function useFungiblePositions(query: PositionsQuery = {}) {
  const { address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  return useQuery({
    queryKey: ['zerion', 'positions', lowerAddress, query],
    queryFn: () => getFungiblePositions(address!, query),
    enabled: !!address,
    retry: shouldRetry,
  });
}

export function useWalletPortfolio(currency: string = 'usd') {
  const { address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  return useQuery({
    queryKey: ['zerion', 'portfolio', lowerAddress, currency],
    queryFn: () => getWalletPortfolio(address!, currency),
    enabled: !!address,
    retry: shouldRetry,
  });
}

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
