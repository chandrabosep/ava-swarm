// Delegate Swarm — EIP-7702 / Calibur-style.
//
// The EOA *is* the account: funds never leave the user's wallet, and
// instead the EOA delegates scoped authority to the agents via a
// single EIP-712 typed-data signature.
//
// Flow:
//   1. Build the DelegationPayload (owner, agent service addresses,
//      target+selector whitelist, 30-day expiry, fresh nonce).
//   2. Ask the user's wallet to sign as EIP-712 typed data.
//   3. POST signature + payload to the agents API. Backend records one
//      Session row per agent so the runtime starts ticking against
//      the user's EOA address.
//
// In live mode (`VITE_LIVE_DELEGATION=true`) this is where we'd also
// submit a 7702 authorization tuple onchain via Calibur. For the
// hackathon scope the off-chain registration is enough — the agents
// can settle through any Calibur-delegated EOA the user prepares
// (Uniswap Wallet does this automatically), and the off-chain record
// gives the dashboard its "delegated" state.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';

import { registerSession } from '@/lib/agents-api';
import { SWARM_SERVICE_ADDRESSES } from '@/config/swarm';
import {
  buildTypedData,
  defaultDelegation,
  type DelegationPayload,
} from '@/lib/delegation';
import type { SessionAgent } from '@/types/swarm';

export type DelegateStage =
  | { type: 'idle' }
  | { type: 'building' }
  | { type: 'awaiting-signature' }
  | { type: 'registering'; agent: SessionAgent }
  | { type: 'done'; payload: DelegationPayload; signature: `0x${string}` }
  | { type: 'failed'; error: Error };

const ALL_AGENTS: SessionAgent[] = ['pm', 'alm', 'router', 'executor'];

const DEMO_MODE =
  (import.meta.env.VITE_DEMO_MODE as string | undefined) === 'true';

export function useDelegateSwarm() {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<DelegateStage>({ type: 'idle' });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!owner) throw new Error('Wallet not connected.');

      setStage({ type: 'building' });
      const payload = defaultDelegation(owner);

      // ----- DEMO PATH ---------------------------------------------------
      // Skip the wallet popup entirely; mint a synthetic signature so the
      // dashboard flips through the same animation. The agents API still
      // records sessions and PM still ticks for the user's EOA.
      let signature: `0x${string}`;
      if (DEMO_MODE) {
        await sleep(400);
        signature = `0x${'de'.repeat(32)}${'mo'.repeat(32)}1c` as `0x${string}`;
      } else {
        setStage({ type: 'awaiting-signature' });
        const typedData = buildTypedData(payload, chainId);
        signature = (await signTypedDataAsync(typedData)) as `0x${string}`;
      }

      // Register one Session row per agent. In live-onchain mode the
      // backend would additionally verify the EIP-712 sig against the
      // user's EOA before storing — for the demo we trust the caller
      // (the extension is the user's browser).
      for (const agent of ALL_AGENTS) {
        setStage({ type: 'registering', agent });
        await registerSession({
          walletAddress: owner, // EOA *is* the account in 7702 mode.
          ownerEoa: owner,
          agent,
          sessionAddress: SWARM_SERVICE_ADDRESSES[agent],
          policyHash: hashFromSignature(signature, agent),
          validUntil: payload.validUntil,
          chains: 'mainnet',
        });
      }

      setStage({ type: 'done', payload, signature });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarm-status'] });
    },
    onError: (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      setStage({ type: 'failed', error });
    },
  });

  return { ...mutation, stage, demoMode: DEMO_MODE };
}

function hashFromSignature(
  signature: `0x${string}`,
  agent: SessionAgent,
): `0x${string}` {
  // Agent-specific suffix so each Session row has its own policyHash —
  // mirrors the per-agent policyHash that the live grant flow would
  // produce. Use a deterministic per-agent suffix so re-running the
  // delegation produces stable hashes.
  const suffix: Record<SessionAgent, string> = {
    pm: '01',
    alm: '02',
    router: '03',
    executor: '04',
  };
  // signature is 132 chars (0x + 130 hex). Trim to 64 hex (32 bytes
  // total) and append the per-agent tag so the result is a 32-byte hex.
  return (signature.slice(0, 64) + suffix[agent]) as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
