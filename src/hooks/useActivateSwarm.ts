// One mutation to rule them all: deploys the Safe, installs the Smart
// Sessions module, generates the two session keypairs, persists them
// encrypted, and grants their on-chain policies. Drives the
// "Activate Swarm" CTA.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useChainId, useWalletClient } from 'wagmi';

import {
  activateOnChain,
  chainFromId,
  createSwarmClient,
  type ActivationStage,
} from '@/lib/safe';
import {
  defaultPolicyFor,
  generateSessionKeypair,
  grantSession,
  storeSession,
  type GrantStage,
} from '@/lib/sessions';
import type { SessionAgent } from '@/types/swarm';

export type SwarmActivationStage =
  | { type: 'idle' }
  | { type: 'deploying'; stage: ActivationStage }
  | { type: 'granting'; agent: SessionAgent; stage: GrantStage }
  | { type: 'done' }
  | { type: 'failed'; error: Error };

const AGENTS: SessionAgent[] = ['alm', 'executor'];

export function useActivateSwarm() {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<SwarmActivationStage>({ type: 'idle' });

  const mutation = useMutation({
    mutationFn: async () => {
      const chain = chainFromId(chainId);
      if (!walletClient || !owner || !chain) {
        throw new Error('Wallet not connected to a supported chain.');
      }

      // 1. Deploy Safe + install Smart Sessions module
      await activateOnChain({
        chain,
        signer: walletClient,
        onProgress: (s) => setStage({ type: 'deploying', stage: s }),
      });

      // 2. Build the SmartAccountClient once for both grants
      const swarmClient = await createSwarmClient({ chain, signer: walletClient });

      // 3. For each agent: generate a keypair, persist encrypted, grant
      //    its policy onchain. Sequential — Smart Sessions doesn't merge
      //    multiple session enables into one UserOp cleanly in the
      //    current SDK, and a fresh signature per agent is cheap UX.
      for (const agent of AGENTS) {
        const keypair = generateSessionKeypair();
        await storeSession({ agent, owner, keypair });
        const policy = defaultPolicyFor(agent, chain);
        await grantSession({
          swarmClient,
          chain,
          agent,
          sessionAddress: keypair.address,
          policy,
          onProgress: (s) => setStage({ type: 'granting', agent, stage: s }),
        });
      }

      setStage({ type: 'done' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['safe'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      setStage({ type: 'failed', error });
    },
  });

  return { ...mutation, stage };
}
