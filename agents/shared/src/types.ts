// Application-level types — shared across agents and used as the schema
// for `Intent.payload` / `Event.payload` JSON columns. Prisma's row-level
// types come from `db.ts`; these types describe what's *inside* the JSON.

import type { AgentRole } from './db.js';

export type SupportedChain =
  | 'unichain'
  | 'base'
  | 'mainnet'
  | 'sepolia'
  | 'base-sepolia';

// --- Intent payload shapes -------------------------------------------------

/**
 * PM → Router: "shift the portfolio toward this allocation."
 *
 * Router decomposes this into a stream of swap intents (Router → Executor)
 * and LP rebalance intents (Router → ALM).
 */
export interface AllocationIntent {
  kind: 'allocation';
  targets: Array<{
    /** Token symbol (USDC, ETH, WBTC, ...) — Router resolves to addresses. */
    symbol: string;
    /** Target weight as a fraction (0..1). All targets sum to ≤ 1. */
    weight: number;
  }>;
  /** Optional max-deviation; below this, Router skips action. */
  toleranceBps?: number;
  /** Free-text reasoning the LLM produced alongside the targets.
   *  Surfaced in the dashboard so users can see *why* the swarm is
   *  rebalancing, not just *that* it is. */
  rationale?: string;
  /** Risk profile name in effect for this allocation (conservative,
   *  balanced, aggressive, degen). Lets the UI render a per-decision
   *  context badge. */
  profile?: string;
}

/**
 * ALM → Router: "I need to swap A for B as part of an LP rebalance."
 */
export interface RebalanceIntent {
  kind: 'rebalance';
  chain: SupportedChain;
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string; // base-unit string (bigint serialized)
  reason: 'range-drift' | 'inventory-shift' | 'manual';
}

/**
 * Router → Executor: "execute this exact swap."
 *
 * The Executor doesn't make policy decisions — by the time it receives a
 * RoutedIntent, the venue, slippage, and route are already chosen.
 */
export interface RoutedIntent {
  kind: 'routed';
  chain: SupportedChain;
  /** Execution venue. For Phase B-1 we always pick uniswap-trade-api. */
  venue: 'uniswap-trade-api';
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** Minimum out, encoded by the venue's quote response. */
  minAmountOut: string;
  /** Pre-built calldata if the venue returned it; otherwise Executor builds. */
  calldata?: string;
  /** USD value of the trade for cap accounting. */
  notionalUsd: number;
  /** Origin intent id, for audit trail. */
  origin: string;
}

/**
 * Executor → everyone: "this is what I did."
 */
export interface ExecutionReceipt {
  kind: 'receipt';
  intentId: string;
  txHash?: string;
  status: 'submitted' | 'mined' | 'failed';
  /** Onchain block number once mined. */
  blockNumber?: number;
  /** Gas used + price for cost reporting. */
  gas?: { used: string; priceWei: string };
  error?: string;
}

export type AnyIntentPayload =
  | AllocationIntent
  | RebalanceIntent
  | RoutedIntent;

// --- Event payload shapes --------------------------------------------------

export type EventKind =
  | 'session.granted'
  | 'session.revoked'
  | 'session.expired'
  | 'intent.created'
  | 'intent.netted'
  | 'intent.routed'
  | 'intent.matched'
  | 'intent.executed'
  | 'intent.failed'
  | 'otc.advertised'
  | 'otc.confirmed'
  | 'agent.heartbeat'
  | 'agent.tick';

// --- OTC matching --------------------------------------------------------

/**
 * Router → AXL: "I have a swap pending — anyone want the opposite side?"
 *
 * Other Routers (serving other tenants) listen, look for opposite intents
 * in their own pending pool, propose a match. If both sides confirm, the
 * swap settles wallet-to-wallet instead of hitting Uniswap.
 */
export interface OtcAdvert {
  /** Stable id for handshake correlation. */
  advertId: string;
  /** Chain we want to settle on. */
  chain: SupportedChain;
  /** Which wallet is offering this side. */
  walletAddress: string;
  /** Token being sold by this wallet. */
  tokenIn: string;
  /** Token wanted in return. */
  tokenOut: string;
  /** USD-denominated notional, for size matching across decimals. */
  notionalUsd: number;
  /** Unix ms — advert is invalid after this. */
  expiresAt: number;
}

/** Reply to an OtcAdvert proposing or accepting a match. */
export interface OtcConfirm {
  /** Echoes the advertId we're matching. */
  advertId: string;
  /** Our own advert id, so the original poster can match it back. */
  counterAdvertId: string;
  /** Confirming side's wallet address. */
  walletAddress: string;
  /** Agreed mid-price as a 1e18 fixed-point ratio (tokenOut per tokenIn). */
  midPrice18: string;
  ack: 'accept' | 'reject';
}

// --- AXL message envelope -------------------------------------------------

/**
 * Standard envelope every agent uses when publishing on AXL. Helps the
 * receiver attribute the message back to a specific tenant + agent.
 */
export interface SwarmMessage<T = unknown> {
  fromAgent: AgentRole;
  walletAddress: string;
  ts: number;
  /** ID of the persisted Intent row this message corresponds to.
   *  Used by subscribers to atomically claim the row (pending →
   *  netted) so AXL gossip, PG LISTEN/NOTIFY, and the DB-poll
   *  fallback don't double-process the same intent. */
  intentId?: string;
  payload: T;
}
