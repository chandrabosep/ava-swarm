// Smart-account / session-key types for the agent swarm.
//
// The model:
//   - SmartAccount      = the user's EOA (under EIP-7702 the EOA itself
//                          acts as a smart account; same address on every
//                          chain, no deploy required)
//   - SessionKey        = a delegated keypair an agent uses to sign UserOps
//   - PermissionPolicy  = the rules the delegation enforces against
//                          each session key
//
// State is layered per-chain because the delegation grant happens
// separately on each chain (even though the address is the same).

import type { Address, Hex } from 'viem';

/**
 * The chains we support. Keep this list aligned with src/config/chains.ts —
 * Reown AppKit + Wagmi need to know about the same set.
 *
 * Testnet build: every name maps to its Sepolia equivalent so the rest of
 * the codebase doesn't need to know it's running on a testnet.
 */
export const SUPPORTED_CHAINS = ['unichain', 'base', 'mainnet'] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/** Numeric chain ids for the supported chains. (Testnet variants.) */
export const CHAIN_ID: Record<SupportedChain, number> = {
  unichain: 1301, // Unichain Sepolia
  base: 84532, // Base Sepolia
  mainnet: 11155111, // Ethereum Sepolia
};

// --- Smart account ---------------------------------------------------------

export interface SmartAccount {
  /**
   * The account address — under EIP-7702 this is just the user's EOA,
   * identical on every supported chain. No factory, no deployment.
   */
  address: Address;
  /** Owners (EOAs) authorized to sign directly. Always [address] in 7702 mode. */
  owners: Address[];
  /** k-of-n multisig threshold. Always 1 in EIP-7702 mode. */
  threshold: number;
  /** Salt nonce — kept for legacy persistence compatibility. */
  saltNonce: string;
  /** Per-chain delegation state. */
  chains: Partial<Record<SupportedChain, ChainDeployment>>;
}

export interface ChainDeployment {
  chain: SupportedChain;
  chainId: number;
  /** True once the EIP-7702 delegation has been authorized on this chain. */
  deployed: boolean;
  /** True once the delegation policy is registered onchain. */
  smartSessionsInstalled: boolean;
  /** Tx hash of the delegation grant. */
  deploymentTxHash?: Hex;
  /** Block number where the delegation was mined, for change tracking. */
  deployedAtBlock?: bigint;
}

// --- Session keys ----------------------------------------------------------

/**
 * Which agent in the swarm a given session represents.
 *
 *   pm, router  — backend-only, do NOT sign onchain. They still get a
 *                 backend Session row so the runtime ticks for them.
 *   alm, executor — sign UserOps via Smart Sessions; need an onchain grant.
 *
 * `defaultPolicyFor()` is only defined for the signing agents.
 */
export type SessionAgent = 'pm' | 'alm' | 'router' | 'executor';
export type SigningSessionAgent = 'alm' | 'executor';

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
