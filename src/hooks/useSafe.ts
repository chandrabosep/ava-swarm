// React hooks over the Safe smart-account state.
//
// useSafe()      — predicted address + per-chain deployment state for the
//                  user's currently-connected chain. Powers the
//                  SmartAccountCard.
// useSessions()  — which session keys exist in localStorage for the
//                  current owner. Returns just the public addresses;
//                  decryption happens lazily when an agent needs to sign.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useChainId } from 'wagmi';
import type { Address } from 'viem';

import {
  predictSmartAccountAddress,
  publicClientFor,
  readDeploymentState,
  chainFromId,
} from '@/lib/safe';
import { listSessionAddresses } from '@/lib/sessions';
import type { SessionAgent } from '@/types/swarm';

const THIRTY_SEC = 30_000;

export function useSafe() {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const chain = useMemo(() => chainFromId(chainId), [chainId]);

  return useQuery({
    queryKey: ['safe', owner?.toLowerCase(), chain],
    queryFn: async () => {
      if (!owner || !chain) return null;
      const safeAddress = await predictSmartAccountAddress(
        { owners: [owner] },
        chain,
      );
      const publicClient = publicClientFor(chain);
      const deployment = await readDeploymentState({
        chain,
        safeAddress,
        publicClient,
      });
      const balance = await publicClient.getBalance({ address: safeAddress });
      return { safeAddress, chain, deployment, balance };
    },
    enabled: !!owner && !!chain,
    staleTime: THIRTY_SEC,
  });
}

export interface SessionAddresses {
  alm?: Address;
  executor?: Address;
}

export function useSessions() {
  const { address: owner } = useAccount();
  return useQuery({
    queryKey: ['sessions', owner?.toLowerCase()],
    queryFn: async (): Promise<SessionAddresses> => {
      if (!owner) return {};
      return listSessionAddresses(owner) as SessionAddresses;
    },
    enabled: !!owner,
    staleTime: 0,
  });
}

export function useSessionAddress(agent: SessionAgent): Address | undefined {
  const { data } = useSessions();
  return data?.[agent];
}
