// Promote the Safe from 1-of-1 to N-of-M by adding another owner.
//
// Sends one UserOp from the existing owner: a self-call to the Safe's
// `addOwnerWithThreshold(newOwner, threshold)`. The Safe verifies the
// caller is the existing owner (via the 4337 module's signature check)
// and applies the change.

import { useState } from 'react';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useChainId, useWalletClient } from 'wagmi';

import { chainFromId, createSwarmClient } from '@/lib/safe';

const SAFE_OWNER_ABI = parseAbi([
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function getOwners() view returns (address[])',
]);

export type AddOwnerStage =
  | { type: 'idle' }
  | { type: 'submitting'; userOpHash?: Hex }
  | { type: 'mined'; txHash: Hex }
  | { type: 'failed'; error: Error };

export interface AddOwnerArgs {
  newOwner: Address;
  /** New threshold. Defaults to keeping the current value. */
  threshold?: number;
}

export function useAddOwner() {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<AddOwnerStage>({ type: 'idle' });

  const mutation = useMutation({
    mutationFn: async ({ newOwner, threshold = 1 }: AddOwnerArgs) => {
      const chain = chainFromId(chainId);
      if (!walletClient || !owner || !chain) {
        throw new Error('Wallet not connected to a supported chain.');
      }

      const swarmClient = await createSwarmClient({ chain, signer: walletClient });

      const data = encodeFunctionData({
        abi: SAFE_OWNER_ABI,
        functionName: 'addOwnerWithThreshold',
        args: [newOwner, BigInt(threshold)],
      });

      const userOpHash =
        await swarmClient.smartAccountClient.sendUserOperation({
          calls: [{ to: swarmClient.address, value: 0n, data }],
        });
      setStage({ type: 'submitting', userOpHash });

      const receipt =
        await swarmClient.smartAccountClient.waitForUserOperationReceipt({
          hash: userOpHash,
        });

      if (!receipt.success) {
        throw new Error(`UserOp ${userOpHash} reverted on ${chain}`);
      }

      setStage({
        type: 'mined',
        txHash: receipt.receipt.transactionHash,
      });
      return receipt.receipt.transactionHash;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['safe'] });
    },
    onError: (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      setStage({ type: 'failed', error });
    },
  });

  return { ...mutation, stage };
}
