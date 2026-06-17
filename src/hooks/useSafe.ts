// React hooks over the Safe smart-account state.
//
// useSafe()      — predicted address + per-chain deployment state for the
//                  user's currently-connected chain. Powers the
//                  SmartAccountCard.
// useSessions()  — Model B: returns the agent service addresses from the
//                  static config when the Safe is activated; empty when
//                  not. The "is granted" question maps to "is the Safe
//                  deployed + module installed" — Phase A's grant flow
//                  registers all sessions atomically.

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
import { SWARM_SERVICE_ADDRESSES } from '@/config/swarm';
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

/**
 * Model B: when the Safe is activated, the granted session addresses are
 * always the agent service addresses. We don't need a per-user localStorage
 * lookup anymore.
 */
export function useSessions(): { data: SessionAddresses | undefined; isLoading: boolean } {
  const safe = useSafe();
  const data = useMemo<SessionAddresses | undefined>(() => {
    if (!safe.data) return undefined;
    const ready =
      safe.data.deployment.deployed &&
      safe.data.deployment.smartSessionsInstalled;
    if (!ready) return {};
    return {
      alm: SWARM_SERVICE_ADDRESSES.alm,
      executor: SWARM_SERVICE_ADDRESSES.executor,
    };
  }, [safe.data]);
  return { data, isLoading: safe.isLoading };
}

export function useSessionAddress(agent: SessionAgent): Address | undefined {
  const { data } = useSessions();
  return data?.[agent];
}
