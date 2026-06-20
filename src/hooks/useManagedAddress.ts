// The wallet the dashboard renders.
//
// In the "agent treasury" model the swarm manages its OWN funded wallet (the
// executor service key), not the connected EOA — that's the account it can
// actually sign Pangolin swaps from. When VITE_TREASURY_ADDRESS is set, the
// portfolio + swarm-status views read that address. Falls back to the
// connected wallet otherwise.

import { useAccount } from 'wagmi';

const TREASURY = (import.meta.env.VITE_TREASURY_ADDRESS as string | undefined)?.trim();

export function useManagedAddress(): `0x${string}` | undefined {
  const { address } = useAccount();
  if (TREASURY && /^0x[a-fA-F0-9]{40}$/.test(TREASURY)) {
    return TREASURY as `0x${string}`;
  }
  return address;
}
