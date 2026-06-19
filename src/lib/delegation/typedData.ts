// EIP-712 typed data for delegating the swarm's agent keys to act on
// behalf of a user's EOA via EIP-7702.
//
// We don't ship a custom delegation target contract for the hackathon
// — instead we model the delegation off-chain (the agents API stores
// the signature + agent pubkeys + scope), and prepare for live onchain
// delegation against a Calibur-style target later.
//
// The signed payload includes:
//   - owner       : the user's EOA
//   - agents      : the four agent service addresses we're authorizing
//   - whitelist   : (target, selector) pairs each agent may invoke
//   - validUntil  : unix seconds — Calibur key expiry analogue
//   - nonce       : random per delegation, prevents replay across the
//                   same signature being submitted twice
//
// The shape matches what an EIP-7702 + GuardedExecutorHook flow would
// expect (one signed authorization that registers a key + sets a
// selector whitelist + applies an expiry), so swapping to live Calibur
// later is a thin onchain translation layer rather than a rewrite.

import type { Address, Hex } from 'viem';

import { SWARM_SERVICE_ADDRESSES } from '@/config/swarm';

export const DELEGATION_TYPED_DATA_VERSION = 1 as const;

export interface DelegationScope {
  /** Target contract the agent may call. */
  target: Address;
  /** 4-byte function selector OR `0x00000000` to mean "any function". */
  selector: Hex;
  /** Human-readable label for the dashboard. */
  label: string;
}

export interface DelegationPayload {
  owner: Address;
  agents: {
    pm: Address;
    alm: Address;
    router: Address;
    executor: Address;
  };
  scopes: DelegationScope[];
  /** Unix seconds the delegation is valid until. */
  validUntil: number;
  /** Random salt per delegation for replay protection. */
  nonce: Hex;
  /** Schema version. */
  version: typeof DELEGATION_TYPED_DATA_VERSION;
}

const TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
  Scope: [
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'label', type: 'string' },
  ],
  Agents: [
    { name: 'pm', type: 'address' },
    { name: 'alm', type: 'address' },
    { name: 'router', type: 'address' },
    { name: 'executor', type: 'address' },
  ],
  SwarmDelegation: [
    { name: 'owner', type: 'address' },
    { name: 'agents', type: 'Agents' },
    { name: 'scopes', type: 'Scope[]' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'version', type: 'uint8' },
  ],
} as const;

export function buildTypedData(
  payload: DelegationPayload,
  chainId: number,
) {
  return {
    domain: {
      name: 'DeFi Swarm',
      version: '1',
      // viem expects chainId as bigint in typed data domains.
      chainId: BigInt(chainId),
    },
    types: TYPES,
    primaryType: 'SwarmDelegation' as const,
    message: {
      owner: payload.owner,
      agents: payload.agents,
      scopes: payload.scopes,
      validUntil: BigInt(payload.validUntil),
      nonce: payload.nonce,
      version: payload.version,
    },
  };
}

/**
 * Default agent scope set: tokens we let Executor swap, hooks ALM may
 * touch. Mirrors what a GuardedExecutorHook would enforce onchain.
 */
export function defaultScopes(): DelegationScope[] {
  return [
    {
      target: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
      selector: '0x3593564c',
      label: 'Universal Router · execute',
    },
    {
      target: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      selector: '0x87517c45',
      label: 'Permit2 · approve',
    },
    {
      target: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
      selector: '0xdd46508f',
      label: 'Uniswap v4 · modifyLiquidities',
    },
  ];
}

export function defaultDelegation(owner: Address): DelegationPayload {
  return {
    owner,
    agents: { ...SWARM_SERVICE_ADDRESSES },
    scopes: defaultScopes(),
    validUntil: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 30 days
    nonce: randomBytes32(),
    version: DELEGATION_TYPED_DATA_VERSION,
  };
}

function randomBytes32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as Hex;
}
