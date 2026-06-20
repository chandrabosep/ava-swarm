// Pre-flight check — disabled.
//
// Originally this shaped the swap list against the KeeperHub execution
// wallet's balances and Uniswap quote coverage before dispatch. KeeperHub
// and the Uniswap rail have been removed — execution is simulated now (see
// executor/src/execute.ts) — so there is nothing to pre-flight against.
//
// Kept as a no-op pass-through so the Router dispatch path is unchanged.
// If a real execution venue is reintroduced, restore the balance/liquidity
// checks here and flip ROUTER_PREFLIGHT=true.

import type { PairSwap } from './decompose.js';

type ProbeLogger = (msg: string, meta?: Record<string, unknown>) => void;

export interface PreflightResult {
  /** Swaps that survived pre-flight. With pre-flight disabled, all of them. */
  swaps: PairSwap[];
  /** Swaps that were dropped, with reason. Always empty while disabled. */
  dropped: Array<{ swap: PairSwap; reason: string }>;
}

export async function preflightSwaps(
  swaps: PairSwap[],
  _log?: ProbeLogger,
): Promise<PreflightResult> {
  return { swaps, dropped: [] };
}

/** Pre-flight is disabled — simulated execution has nothing to check. */
export function preflightEnabled(): boolean {
  return false;
}
