// Smart-account / session-key types for the agent swarm.
//
// The model:
//   - SmartAccount      = the Safe (one deterministic address, deployed
//                          per-chain on demand)
//   - SessionKey        = a delegated keypair an agent uses to sign UserOps
//   - PermissionPolicy  = the rules onchain Smart Sessions enforces against
//                          each session key
//
// State is layered per-chain because deployment + module install + grants
// happen separately on each chain (even though the address is the same).

import type { Address, Hex } from 'viem';

/**
 * The chains we support. Keep this list aligned with src/config/chains.ts —
 * Reown AppKit + Wagmi need to know about the same set.
 */
export const SUPPORTED_CHAINS = ['unichain', 'base', 'mainnet'] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/** Numeric chain ids for the supported chains. */
export const CHAIN_ID: Record<SupportedChain, number> = {
  unichain: 130,
  base: 8453,
  mainnet: 1,
};

// --- Smart account ---------------------------------------------------------

export interface SmartAccount {
  /**
   * Deterministic address — identical on every supported chain. Computed
   * via the canonical Safe proxy factory + same owners + same salt + same
   * 4337 fallback handler. See src/lib/safe/predict.ts.
   */
  address: Address;
  /** Owners (EOAs) authorized to sign on the Safe directly. */
  owners: Address[];
  /** k-of-n multisig threshold. Starts at 1; user can promote later. */
  threshold: number;
  /** Salt nonce used at deploy time — needs to match for cross-chain parity. */
  saltNonce: string;
  /** Per-chain deployment + module state. */
  chains: Partial<Record<SupportedChain, ChainDeployment>>;
}

export interface ChainDeployment {
  chain: SupportedChain;
  chainId: number;
  /** True once the Safe contract exists onchain. */
  deployed: boolean;
  /** True once the Smart Sessions validator module is installed. */
  smartSessionsInstalled: boolean;
  /** UserOp hash that performed the deploy + module install bundle. */
  deploymentTxHash?: Hex;
  /** Block number where the deployment was mined, for change tracking. */
  deployedAtBlock?: bigint;
}

// --- Session keys ----------------------------------------------------------

/** Which agent in the swarm a given session key represents. */
export type SessionAgent = 'alm' | 'executor';

export interface SessionKey {
  agent: SessionAgent;
  /** Public address of the session keypair. */
  address: Address;
  /** Permissions registered onchain for this key. */
  policy: PermissionPolicy;
  /** Unix ms — when the user signed the grant. */
  grantedAt: number;
  /** Per-chain registration state. */
  chains: Partial<Record<SupportedChain, SessionChainState>>;
}

export interface SessionChainState {
  chain: SupportedChain;
  chainId: number;
  /** True once the Smart Sessions module has the policy stored. */
  registered: boolean;
  /** UserOp hash of the grant transaction. */
  registrationTxHash?: Hex;
}

// --- Permission DSL --------------------------------------------------------

/**
 * The policy a session key operates under, expressed in our own DSL. The
 * grant flow translates this into the Smart Sessions module's onchain
 * representation; agent code never needs to know that translation exists.
 */
export interface PermissionPolicy {
  /** Whitelisted contract calls. */
  actions: PolicyAction[];
  /** Per-tx max USD value (6-decimal fixed point). */
  maxPerTxUsd?: bigint;
  /** Per-day cumulative max USD (6-decimal fixed point). */
  maxPerDayUsd?: bigint;
  /** ALM-only: max LP inventory shift per 24h, in basis points (2500 = 25%). */
  maxInventoryShiftBps?: number;
  /** Token whitelist. Empty / undefined = no token-level restriction. */
  tokenWhitelist?: Address[];
  /** ALM-only: pool / hook whitelist. */
  poolWhitelist?: Address[];
  /** Unix seconds — policy invalid after this. */
  validUntil: number;
}

export interface PolicyAction {
  /** Contract the session key may call. */
  contract: Address;
  /**
   * 4-byte function selector (e.g. `0x12345678`) the session key may invoke,
   * or `'any'` to allow any function on the contract.
   */
  selector: Hex | 'any';
}

// --- Persistence layer -----------------------------------------------------

/**
 * Wire format for a session keypair persisted to localStorage. The private
 * key is encrypted with a key derived from the owner EOA so a stolen blob
 * is useless without the user's wallet.
 */
export interface StoredSessionBlob {
  agent: SessionAgent;
  /** Public address (recoverable from the private key, but cached for speed). */
  address: Address;
  /** Encryption IV (base64). */
  iv: string;
  /** AES-GCM-encrypted private key bytes (base64). */
  cipherText: string;
  /** Owner EOA — used as input to the key-derivation function. */
  owner: Address;
  /** Schema version for forward-compat. */
  version: 1;
}
