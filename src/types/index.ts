// Shared types — placeholders for later agent / swap wiring.
// Keep this file lean; swap-execution and intent-routing types will land in
// later phases when we integrate Uniswap + KeeperHub.

export type AgentRole = 'pm' | 'alm' | 'router' | 'executor';

export type AgentStatus = 'offline' | 'idle' | 'busy';

export interface Agent {
  id: string;
  role: AgentRole;
  status: AgentStatus;
  /** Unix ms */
  lastSeen: number;
}

export type IntentStatus = 'pending' | 'netted' | 'routed' | 'executed';

export interface Intent {
  id: string;
  from: AgentRole;
  tokenIn: string;
  tokenOut: string;
  /** Human-readable amount string (we'll switch to bigint when this gets real) */
  amount: string;
  /** Unix ms */
  createdAt: number;
  status: IntentStatus;
}

export interface PortfolioSummary {
  totalValueUsd: number;
  change24hUsd: number;
  change24hPct: number;
  allocations: AllocationSlice[];
}

export interface AllocationSlice {
  symbol: string;
  pct: number;
  valueUsd: number;
}
