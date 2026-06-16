// Read Safe deployment state across every supported chain in one hook.
// Powers the cross-chain expansion UI: shows the user which chains have
// the Safe deployed and which don't.

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Address } from 'viem';

import {
  predictSmartAccountAddress,
  publicClientFor,
  readDeploymentState,
} from '@/lib/safe';
import {
  CHAIN_ID,
  SUPPORTED_CHAINS,
  type ChainDeployment,
  type SupportedChain,
} from '@/types/swarm';

export interface AllChainsState {
  /** Same address on every chain. */
  safeAddress: Address;
  /** Per-chain deployment + module state. */
  byChain: Record<SupportedChain, ChainDeployment>;
}

export function useSafeAllChains() {
  const { address: owner } = useAccount();
  return useQuery({
    queryKey: ['safe-all-chains', owner?.toLowerCase()],
    queryFn: async (): Promise<AllChainsState | null> => {
      if (!owner) return null;
      const safeAddress = await predictSmartAccountAddress(
        { owners: [owner] },
        'mainnet',
      );
      const entries = await Promise.all(
        SUPPORTED_CHAINS.map(async (chain): Promise<[SupportedChain, ChainDeployment]> => {
          const publicClient = publicClientFor(chain);
          const state = await readDeploymentState({
            chain,
            safeAddress,
            publicClient,
          });
          return [chain, state];
        }),
      );
      const byChain = Object.fromEntries(entries) as Record<
        SupportedChain,
        ChainDeployment
      >;
      // Make sure every supported chain has an entry, even if unreached.
      for (const c of SUPPORTED_CHAINS) {
        if (!byChain[c]) {
          byChain[c] = {
            chain: c,
            chainId: CHAIN_ID[c],
            deployed: false,
            smartSessionsInstalled: false,
          };
        }
      }
      return { safeAddress, byChain };
    },
    enabled: !!owner,
    staleTime: 60_000,
  });
}
