// Expand the swarm to an additional chain — Model B.
//
// Switch network, deploy Safe + install Smart Sessions, re-grant the
// agents' service addresses for that chain. Service keypairs are the
// same across chains (they're held by the agent server, not per-chain),
// so the only per-chain work is the onchain registration.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';

import {
  activateOnChain,
  createSwarmClient,
  type ActivationStage,
} from '@/lib/safe';
import {
  defaultPolicyFor,
  grantSession,
  type GrantStage,
} from '@/lib/sessions';
import { SWARM_SERVICE_ADDRESSES } from '@/config/swarm';
import {
  CHAIN_ID,
  type SessionAgent,
  type SupportedChain,
} from '@/types/swarm';

const AGENTS: SessionAgent[] = ['alm', 'executor'];

export type ExpandStage =
  | { type: 'idle' }
  | { type: 'switching' }
  | { type: 'deploying'; stage: ActivationStage }
  | { type: 'granting'; agent: SessionAgent; stage: GrantStage }
  | { type: 'done' }
  | { type: 'failed'; error: Error };

export function useExpandToChain() {
  const { address: owner } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<ExpandStage>({ type: 'idle' });

  const mutation = useMutation({
    mutationFn: async (target: SupportedChain) => {
      if (!walletClient || !owner) {
        throw new Error('Wallet not connected.');
      }

      setStage({ type: 'switching' });
      await switchChainAsync({ chainId: CHAIN_ID[target] });

      await activateOnChain({
        chain: target,
        signer: walletClient,
        onProgress: (s) => setStage({ type: 'deploying', stage: s }),
      });

      const swarmClient = await createSwarmClient({
        chain: target,
        signer: walletClient,
      });

      // Same service addresses on this chain. The agents already hold
      // their keypairs from env; we just register them with this Safe's
      // Smart Sessions module on the new chain.
      for (const agent of AGENTS) {
        const sessionAddress = SWARM_SERVICE_ADDRESSES[agent];
        if (
          sessionAddress === '0x0000000000000000000000000000000000000000'
        ) continue;
        const policy = defaultPolicyFor(agent, target);
        await grantSession({
          swarmClient,
          chain: target,
          agent,
          sessionAddress,
          policy,
          onProgress: (s) => setStage({ type: 'granting', agent, stage: s }),
        });
      }

      setStage({ type: 'done' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['safe'] });
      queryClient.invalidateQueries({ queryKey: ['safe-all-chains'] });
    },
    onError: (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      setStage({ type: 'failed', error });
    },
  });

  return { ...mutation, stage };
}
