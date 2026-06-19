// Bridge wagmi's signMessageAsync into the agents-auth module so that
// plain (non-component) modules like `agents-api.ts` can attach an auth
// header without holding a hook. Mount this once at app root.

import { useEffect } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

import { clearAuthSigner, registerAuthSigner } from '@/lib/agents-auth';

export function useAuthSigner(): void {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  useEffect(() => {
    if (!address) {
      clearAuthSigner();
      return;
    }
    registerAuthSigner(address, async (message: string) => {
      const sig = await signMessageAsync({ message });
      return sig as `0x${string}`;
    });
    return () => {
      clearAuthSigner();
    };
  }, [address, signMessageAsync]);
}
