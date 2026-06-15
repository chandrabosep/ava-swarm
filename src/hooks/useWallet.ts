// Thin wrapper around wagmi's connection hooks. Components should prefer this
// over importing from wagmi directly so that the swap to a different connector
// stack later (if it ever happens) stays a one-file change.
import { useAccount, useChainId } from 'wagmi';
import { shortAddress } from '@/lib/format';

export function useWallet() {
  const { address, isConnected, status } = useAccount();
  const chainId = useChainId();

  return {
    address,
    chainId,
    isConnected,
    status,
    displayAddress: address ? shortAddress(address) : undefined,
  };
}
