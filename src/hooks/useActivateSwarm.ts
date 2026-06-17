// Activate Swarm — Model B.
//
// Single mutation that deploys the Safe, installs the Smart Sessions
// module, and grants the agents' service addresses (read from
// src/config/swarm.ts) the policies defined in src/lib/sessions/policies.
//
// The extension never holds session privkeys — the agents do. This is
// the security improvement Model B buys us over Model A.

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
  grantSession,
  type GrantStage,
} from '@/lib/sessions';
import { SWARM_SERVICE_ADDRESSES } from '@/config/swarm';
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

      // 3. Grant each agent its policy. No keypair generation: the agent
      //    holds the privkey on its server, we just authorize its
      //    pre-published service address to act under our policy.
      for (const agent of AGENTS) {
        const sessionAddress = SWARM_SERVICE_ADDRESSES[agent];
        if (
          sessionAddress === '0x0000000000000000000000000000000000000000'
        ) {
          throw new Error(
            `Service address for ${agent} not configured. Update src/config/swarm.ts.`,
          );
        }
        const policy = defaultPolicyFor(agent, chain);
        await grantSession({
          swarmClient,
          chain,
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
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      setStage({ type: 'failed', error });
    },
  });

  return { ...mutation, stage };
}
