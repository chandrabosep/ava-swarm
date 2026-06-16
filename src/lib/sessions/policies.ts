// Default permission policies for the two agents that need onchain auth:
// Executor (swaps via Universal Router + Permit2) and ALM (LP management
// via Uniswap v4 PoolManager + PositionManager).
//
// These caps are intentionally tight for first-time activation. The user
// can widen them later via a (future) settings UI; the dashboard always
// shows the current caps so there's no hidden authorization.

import type { Address, Hex } from 'viem';

import type {
  PermissionPolicy,
  PolicyAction,
  SessionAgent,
  SupportedChain,
} from '@/types/swarm';

// --- Canonical contract addresses, per chain --------------------------------
//
// Universal Router and Permit2 are at canonical (same) addresses across most
// EVM chains via deterministic deployment, but Uniswap publishes per-chain
// official addresses, so we look them up explicitly. Sources:
//   https://docs.uniswap.org/contracts/v4/deployments
//   https://docs.uniswap.org/contracts/permit2/overview

interface ChainContracts {
  universalRouter: Address;
  permit2: Address;
  v4PoolManager: Address;
  v4PositionManager: Address;
}

export const CONTRACTS: Record<SupportedChain, ChainContracts> = {
  // Ethereum Mainnet
  mainnet: {
    universalRouter: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    v4PositionManager: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
  },
  // Base
  base: {
    universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    v4PositionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  },
  // Unichain
  unichain: {
    universalRouter: '0xEf740bf23aCaE26f6492B10de645D6B98dC8Eaf3',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    v4PoolManager: '0x1F98400000000000000000000000000000000004',
    v4PositionManager: '0x4529A01c7A0410167c5740C487A8DE60232617bf',
  },
};

// --- Function selectors we whitelist ---------------------------------------
// Computed from the canonical Uniswap ABIs. Hardcoded here so the policy
// definition is self-contained and reviewable.

const SEL = {
  /** UniversalRouter.execute(bytes,bytes[],uint256) */
  universalRouterExecute: '0x3593564c' as Hex,
  /** Permit2.permit(...) */
  permit2Permit: '0x2b67b570' as Hex,
  /** Permit2.transferFrom(...) */
  permit2TransferFrom: '0x36c78516' as Hex,
  /** PoolManager.unlock(bytes) */
  poolManagerUnlock: '0x48c89491' as Hex,
  /** PositionManager.modifyLiquidities(bytes,uint256) */
  positionManagerModifyLiquidities: '0xdd46508f' as Hex,
} as const;

// --- TTL --------------------------------------------------------------------

/** Default session lifetime — 7 days, refreshed by user re-signing. */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

/** Compute a `validUntil` Unix-seconds timestamp `ttl` from now. */
export function ttlFromNow(ttl: number = DEFAULT_TTL_SECONDS): number {
  return Math.floor(Date.now() / 1000) + ttl;
}

// --- Policy factories -------------------------------------------------------

/** USD with 6-decimal precision (matches Smart Sessions onchain encoding). */
function usd(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

/**
 * Executor — swap-only authority. Universal Router + Permit2, with per-tx
 * + per-day USD caps. No token whitelist by default (Executor needs to
 * touch whatever the portfolio manager decides to rebalance into); the
 * USD caps + Smart Sessions' value-tracking are the safety net.
 */
export function defaultExecutorPolicy(
  chain: SupportedChain,
  overrides: Partial<PermissionPolicy> = {},
): PermissionPolicy {
  const c = CONTRACTS[chain];
  const actions: PolicyAction[] = [
    { contract: c.universalRouter, selector: SEL.universalRouterExecute },
    { contract: c.permit2, selector: SEL.permit2Permit },
    { contract: c.permit2, selector: SEL.permit2TransferFrom },
  ];
  return {
    actions,
    maxPerTxUsd: usd(1_000),
    maxPerDayUsd: usd(10_000),
    validUntil: ttlFromNow(),
    ...overrides,
  };
}

/**
 * ALM — Uniswap v4 LP management. PoolManager + PositionManager only.
 * `maxInventoryShiftBps` caps how much of the Safe's LP balance can move
 * within 24h (enforced by the Smart Sessions policy contract).
 */
export function defaultAlmPolicy(
  chain: SupportedChain,
  overrides: Partial<PermissionPolicy> = {},
): PermissionPolicy {
  const c = CONTRACTS[chain];
  const actions: PolicyAction[] = [
    { contract: c.v4PoolManager, selector: SEL.poolManagerUnlock },
    {
      contract: c.v4PositionManager,
      selector: SEL.positionManagerModifyLiquidities,
    },
  ];
  return {
    actions,
    maxInventoryShiftBps: 2500, // 25%
    validUntil: ttlFromNow(),
    ...overrides,
  };
}

/** Pick the right default for an agent. */
export function defaultPolicyFor(
  agent: SessionAgent,
  chain: SupportedChain,
  overrides: Partial<PermissionPolicy> = {},
): PermissionPolicy {
  return agent === 'alm'
    ? defaultAlmPolicy(chain, overrides)
    : defaultExecutorPolicy(chain, overrides);
}
