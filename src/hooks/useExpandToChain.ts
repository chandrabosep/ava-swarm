// Expand the swarm to an additional chain.
//
// Steps: switch network, deploy Safe + install Smart Sessions there,
// re-grant the existing session keypairs (which already exist in
// localStorage from the original activation) for that chain. After
// this runs the user has a Safe at the same address on N+1 chains.

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
  listSessionAddresses,
  type GrantStage,
} from '@/lib/sessions';
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

      // 1. Make the wallet switch to the target chain. wagmi prompts the
      //    user; if they reject, this throws and we surface the error.
      setStage({ type: 'switching' });
      await switchChainAsync({ chainId: CHAIN_ID[target] });

      // 2. Deploy Safe + install module on the new chain.
      await activateOnChain({
        chain: target,
        signer: walletClient,
        onProgress: (s) => setStage({ type: 'deploying', stage: s }),
      });

      // 3. Re-grant existing session keys on the new chain.
      const swarmClient = await createSwarmClient({
        chain: target,
        signer: walletClient,
      });
      const existing = listSessionAddresses(owner);
      for (const agent of AGENTS) {
        const sessionAddress = existing[agent];
        if (!sessionAddress) continue;
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
