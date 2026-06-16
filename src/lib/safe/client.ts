// Pimlico + Safe smart-account client wiring.
//
// One factory function: `createSwarmClient(chain, signer)` returns the
// SmartAccountClient we use for everything — predicting addresses, sending
// UserOps, reading Safe state. The factory is per-chain because Pimlico's
// bundler endpoint is chain-scoped and the Safe address (while same across
// chains) gets deployed independently per chain.

import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type Transport,
  type WalletClient,
} from 'viem';
import { mainnet, base, unichain } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';

import {
  CHAIN_ID,
  type SupportedChain,
} from '@/types/swarm';
import {
  DEFAULT_SALT_NONCE,
  SAFE_VERSION,
  SAFE_4337_MODULE_ADDRESS,
} from './predict';

const pimlicoApiKey = import.meta.env.VITE_PIMLICO_API_KEY as string | undefined;

if (!pimlicoApiKey) {
  console.warn(
    '[safe] VITE_PIMLICO_API_KEY is not set. Smart-account UserOps will fail. Get a key at https://dashboard.pimlico.io',
  );
}

const VIEM_CHAIN: Record<SupportedChain, Chain> = {
  mainnet,
  base,
  unichain,
};

function pimlicoBundlerUrl(chain: SupportedChain): string {
  const id = CHAIN_ID[chain];
  return `https://api.pimlico.io/v2/${id}/rpc?apikey=${pimlicoApiKey ?? 'missing'}`;
}

/**
 * Public-client (read-only RPC) for a given chain. Used to snapshot Safe
 * state — owners, modules, balance — without spending gas.
 */
export function publicClientFor(chain: SupportedChain) {
  return createPublicClient({
    chain: VIEM_CHAIN[chain],
    transport: http() as Transport,
  });
}

/**
 * Pimlico client — talks to the bundler RPC. Used for fee estimation and
 * UserOp tracking. SmartAccountClient consumes this internally.
 */
export function pimlicoClientFor(chain: SupportedChain) {
  return createPimlicoClient({
    transport: http(pimlicoBundlerUrl(chain)) as Transport,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });
}

export interface SwarmClientParams {
  chain: SupportedChain;
  /**
   * The owner's wallet client (from wagmi). Used to sign UserOps on behalf
   * of the Safe. For Phase A we sign with the user's EOA; in Phase B the
   * agents sign with their session keys against the same SmartAccountClient
   * abstraction.
   */
  signer: WalletClient;
  /** Salt nonce — lets us namespace multiple Safes per owner. Defaults to 0. */
  saltNonce?: bigint;
}

/**
 * Builds the SmartAccountClient for our Safe. This is the single object
 * the rest of the swarm code talks to: `client.sendUserOperation(...)`,
 * `client.account.address`, etc.
 *
 * The Safe is counterfactually addressed — it doesn't have to be deployed
 * onchain yet. The first UserOp we send (in deploy.ts) will deploy it.
 */
export async function createSwarmClient(params: SwarmClientParams) {
  const { chain, signer, saltNonce = BigInt(DEFAULT_SALT_NONCE) } = params;

  const publicClient = publicClientFor(chain);
  const pimlicoClient = pimlicoClientFor(chain);

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [signer],
    version: SAFE_VERSION,
    saltNonce,
    safe4337ModuleAddress: SAFE_4337_MODULE_ADDRESS,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  const smartAccountClient = createSmartAccountClient({
    account: safeAccount,
    chain: VIEM_CHAIN[chain],
    bundlerTransport: http(pimlicoBundlerUrl(chain)) as Transport,
    // No paymaster — user funds the Safe with ETH for gas.
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  return {
    smartAccountClient,
    publicClient,
    pimlicoClient,
    /** Predicted (or deployed) Safe address. */
    address: safeAccount.address as Address,
  };
}

export type SwarmClient = Awaited<ReturnType<typeof createSwarmClient>>;
