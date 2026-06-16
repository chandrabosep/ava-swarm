// Deterministic Safe address prediction.
//
// Why this is a thing: the Safe protocol deploys via CREATE2 from a canonical
// proxy factory. As long as we use the same factory + same singleton + same
// initializer (owners + threshold + fallback handler) + same salt, we get
// the same Safe address on every EVM chain. That's how we hand the user
// "your address is 0xabc... everywhere" instead of forcing them to remember
// three different addresses.
//
// We bake the Safe 4337 module address into the fallback handler at predict
// time so the eventual deployed Safe — which IS 4337-enabled — matches the
// predicted address. If we predicted with a vanilla fallback handler then
// later deployed with the 4337 module, we'd get a different address.

import Safe, { type PredictedSafeProps } from '@safe-global/protocol-kit';
import type { Address } from 'viem';
import { mainnet, base, unichain } from 'viem/chains';

import {
  CHAIN_ID,
  type SupportedChain,
} from '@/types/swarm';

/**
 * Canonical Safe 4337 module v0.3 address — same on Mainnet, Base, Unichain
 * (and every other chain Safe officially deploys to). This is what the Safe
 * uses as its ERC-4337 entry point.
 */
export const SAFE_4337_MODULE_ADDRESS: Address =
  '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226';

/** Safe v1.4.1. We pin so the predicted address stays stable. */
export const SAFE_VERSION = '1.4.1' as const;

/**
 * Default salt nonce. Keeping this `'0'` for the first Safe means
 * `predict(owners, 1)` always returns the same address for a given owner
 * — useful for "your Safe address is X" UX. Pass a different nonce if you
 * want to deploy multiple Safes for the same owner.
 */
export const DEFAULT_SALT_NONCE = '0';

const RPC_URL: Record<SupportedChain, string> = {
  mainnet: mainnet.rpcUrls.default.http[0],
  base: base.rpcUrls.default.http[0],
  unichain: unichain.rpcUrls.default.http[0],
};

export interface PredictParams {
  /** EOA(s) authorized as Safe owners. Order matters for address derivation. */
  owners: Address[];
  /** Multisig threshold. Defaults to 1. */
  threshold?: number;
  /** Salt nonce. Defaults to `'0'`. */
  saltNonce?: string;
}

/**
 * Predict the Safe address for a given owner config.
 *
 * The address is independent of the chain we query — we accept a chain just
 * to pick an RPC for the SDK. We default to Mainnet because it's the most
 * stable public RPC.
 */
export async function predictSmartAccountAddress(
  params: PredictParams,
  chain: SupportedChain = 'mainnet',
): Promise<Address> {
  const predictedSafe: PredictedSafeProps = {
    safeAccountConfig: {
      owners: params.owners,
      threshold: params.threshold ?? 1,
      // Crucially: bake the 4337 module address into the fallback handler so
      // the predicted address matches what we eventually deploy.
      fallbackHandler: SAFE_4337_MODULE_ADDRESS,
    },
    safeDeploymentConfig: {
      saltNonce: params.saltNonce ?? DEFAULT_SALT_NONCE,
      safeVersion: SAFE_VERSION,
    },
  };

  const sdk = await Safe.init({
    provider: RPC_URL[chain],
    predictedSafe,
  });

  return (await sdk.getAddress()) as Address;
}

/**
 * Cross-chain sanity check. Predict the address on every supported chain
 * and assert they match. Useful for tests / dev assertions; in prod the
 * factory + version + initializer being identical guarantees this.
 */
export async function assertCrossChainAddressParity(
  params: PredictParams,
): Promise<Address> {
  const chains: SupportedChain[] = ['mainnet', 'base', 'unichain'];
  const addresses = await Promise.all(
    chains.map((c) => predictSmartAccountAddress(params, c)),
  );
  const [first, ...rest] = addresses;
  if (rest.some((a) => a.toLowerCase() !== first.toLowerCase())) {
    throw new Error(
      `Predicted Safe addresses differ across chains: ${chains
        .map((c, i) => `${c}=${addresses[i]}`)
        .join(', ')}`,
    );
  }
  return first;
}

/** Convenience: numeric chain id for a SupportedChain. */
export function chainIdOf(chain: SupportedChain): number {
  return CHAIN_ID[chain];
}

/** Numeric chain id → SupportedChain. Returns null for unsupported ids. */
export function chainFromId(chainId: number): SupportedChain | null {
  for (const c of Object.keys(CHAIN_ID) as SupportedChain[]) {
    if (CHAIN_ID[c] === chainId) return c;
  }
  return null;
}
