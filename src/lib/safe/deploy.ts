// Safe deployment + Smart Sessions module install.
//
// The "Activate Swarm" CTA on the dashboard fires `activateOnChain()`. It
// builds a single batched UserOp that:
//   1. Deploys the Safe (counterfactual deploy is implicit on first UserOp;
//      the bundler includes the factory call as initCode).
//   2. Installs the Smart Sessions validator module so session keys can be
//      registered against this Safe in the next step.
//
// Granting individual session keys (per-agent permissions) happens in
// src/lib/sessions/grant.ts. We split the two flows because cross-chain
// expansion only ever needs to repeat *this* part — once a chain has a
// deployed Safe + Smart Sessions module, all the per-agent grants from
// the user's first activation can be re-applied without a fresh UserOp
// shape.

import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  getSmartSessionsValidator,
} from '@rhinestone/module-sdk';

import { createSwarmClient, type SwarmClientParams } from './client';
import {
  type ChainDeployment,
  type SupportedChain,
  CHAIN_ID,
} from '@/types/swarm';

/**
 * Minimal Safe ABI for the bits we touch from outside the SDK. The full
 * Safe ABI is huge; this is the subset that matters here.
 */
const SAFE_ABI = parseAbi([
  'function enableModule(address module)',
  'function isModuleEnabled(address module) view returns (bool)',
]);

export interface ActivateOnChainParams extends SwarmClientParams {
  /**
   * Hook for the UI to react to each lifecycle stage — UserOp built,
   * UserOp submitted, included on chain. Optional.
   */
  onProgress?: (stage: ActivationStage) => void;
}

export type ActivationStage =
  | { type: 'building' }
  | { type: 'submitting'; userOpHash?: Hex }
  | { type: 'mined'; txHash: Hex; blockNumber: bigint }
  | { type: 'failed'; error: Error };

export interface ActivationResult {
  chain: SupportedChain;
  safeAddress: Address;
  deployment: ChainDeployment;
}

/**
 * Idempotent: if the Safe is already deployed and the module is already
 * installed, returns the existing state without sending a UserOp. Cheap
 * to call after every reload to refresh status.
 */
export async function activateOnChain(
  params: ActivateOnChainParams,
): Promise<ActivationResult> {
  const { chain, onProgress } = params;
  const { smartAccountClient, publicClient, address } =
    await createSwarmClient(params);

  // Quick read: is the Safe already deployed and is the module already on?
  const existing = await readDeploymentState({
    chain,
    safeAddress: address,
    publicClient,
  });
  if (existing.deployed && existing.smartSessionsInstalled) {
    return { chain, safeAddress: address, deployment: existing };
  }

  onProgress?.({ type: 'building' });

  const sessionsValidator = getSmartSessionsValidator({});

  // Build the calls. If the Safe isn't deployed yet, the SmartAccountClient
  // automatically prepends the factory deploy as initCode in the UserOp,
  // so we don't list it explicitly. We just enqueue the module-install
  // call against `address` — same Safe.
  const calls = existing.smartSessionsInstalled
    ? []
    : [
        {
          to: address,
          value: 0n,
          data: encodeFunctionData({
            abi: SAFE_ABI,
            functionName: 'enableModule',
            args: [sessionsValidator.address as Address],
          }),
        },
      ];

  // Edge case: Safe is deployed but has no module yet AND we have nothing
  // to do (smart-sessions already installed). Bail out clean.
  if (calls.length === 0) {
    return { chain, safeAddress: address, deployment: existing };
  }

  let userOpHash: Hex;
  try {
    userOpHash = await smartAccountClient.sendUserOperation({ calls });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onProgress?.({ type: 'failed', error });
    throw error;
  }

  onProgress?.({ type: 'submitting', userOpHash });

  const receipt = await smartAccountClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  if (!receipt.success) {
    const error = new Error(
      `UserOp ${userOpHash} reverted on ${chain} (block ${receipt.receipt.blockNumber})`,
    );
    onProgress?.({ type: 'failed', error });
    throw error;
  }

  onProgress?.({
    type: 'mined',
    txHash: receipt.receipt.transactionHash,
    blockNumber: receipt.receipt.blockNumber,
  });

  return {
    chain,
    safeAddress: address,
    deployment: {
      chain,
      chainId: CHAIN_ID[chain],
      deployed: true,
      smartSessionsInstalled: true,
      deploymentTxHash: receipt.receipt.transactionHash,
      deployedAtBlock: receipt.receipt.blockNumber,
    },
  };
}

interface ReadStateParams {
  chain: SupportedChain;
  safeAddress: Address;
  publicClient: ReturnType<
    typeof import('./client').publicClientFor
  >;
}

/**
 * Read whether the Safe is deployed (any code at the address) and whether
 * the Smart Sessions module is enabled. Used both before activation
 * (idempotency check) and by the dashboard for status badges.
 */
export async function readDeploymentState({
  chain,
  safeAddress,
  publicClient,
}: ReadStateParams): Promise<ChainDeployment> {
  const sessionsValidator = getSmartSessionsValidator({});
  const moduleAddress = sessionsValidator.address as Address;

  const code = await publicClient.getCode({ address: safeAddress });
  const deployed = !!code && code !== '0x';

  let smartSessionsInstalled = false;
  if (deployed) {
    try {
      smartSessionsInstalled = (await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: 'isModuleEnabled',
        args: [moduleAddress],
      })) as boolean;
    } catch {
      // Pre-1.4 Safes or partial deployments can throw here; treat as not
      // installed and let activation handle it.
      smartSessionsInstalled = false;
    }
  }

  return {
    chain,
    chainId: CHAIN_ID[chain],
    deployed,
    smartSessionsInstalled,
  };
}
