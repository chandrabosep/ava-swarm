// Live marketplace state — polls the agents API for the "agents that hire
// agents" view: the specialist roster with on-chain ERC-8004 reputation, and
// the recent x402 payment feed. Public (no wallet needed) so the panel renders
// the moment the agents API is up.

import { useQuery } from '@tanstack/react-query';

import { AGENTS_API_URL } from '@/config/swarm';

export interface MarketplaceSpecialist {
  role: string;
  label: string;
  description: string;
  path: string;
  price: string;
  payTo: string | null;
  agentId: number | null;
  reputation: { count: number; avgScore: number };
}

export interface MarketplaceHire {
  ts: string;
  specialist: string | null;
  label: string | null;
  tag: string | null;
  agentId: number | null;
  price: string | null;
  payTo: string | null;
  ok: boolean;
  score: number | null;
  repBefore: number | null;
  payTxHash: string | null;
  feedbackTx: string | null;
  result: unknown;
  error: string | null;
}

export interface MarketplaceData {
  network: string;
  facilitator: string;
  marketplaceUrl: string;
  identityRegistry: string | null;
  reputationRegistry: string | null;
  specialists: MarketplaceSpecialist[];
  hires: MarketplaceHire[];
}

export function useMarketplace() {
  return useQuery<MarketplaceData>({
    queryKey: ['marketplace'],
    // The x402 marketplace is ALWAYS live testnet data — never demo. This
    // panel shows real x402 settlements + ERC-8004 reputation, independent of
    // VITE_DEMO_FEED (which only governs the feed/portfolio/risk surfaces).
    queryFn: async () => {
      const res = await fetch(`${AGENTS_API_URL}/api/marketplace`);
      if (!res.ok) throw new Error(`marketplace ${res.status}`);
      return (await res.json()) as MarketplaceData;
    },
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
}
