// Remaining mock data — only the agent swarm cards still rely on this.
// Portfolio data is live via Zerion (src/hooks/usePortfolio.ts), and the
// Recent activity rail now reads from Zerion's transactions endpoint.

import type { Agent, AgentRole } from '@/types';

const HOUR = 60 * 60 * 1000;
const now = Date.now();

export const ROLE_LABELS: Record<AgentRole, string> = {
  pm: 'Portfolio Manager',
  alm: 'Active Liquidity Manager',
  router: 'Intent Router',
  executor: 'Swap Executor',
};

export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  pm: 'Sets target allocation and risk envelope for the portfolio.',
  alm: 'Manages Uniswap v3/v4 LP ranges and rebalances inventory.',
  router: 'Nets internal intents and chooses execution venues.',
  executor: 'Submits signed swaps via Universal Router + Permit2.',
};

export const mockAgents: Agent[] = [
  { id: 'agent-pm', role: 'pm', status: 'offline', lastSeen: now - 6 * HOUR },
  { id: 'agent-alm', role: 'alm', status: 'offline', lastSeen: now - 6 * HOUR },
  { id: 'agent-router', role: 'router', status: 'offline', lastSeen: now - 6 * HOUR },
  { id: 'agent-executor', role: 'executor', status: 'offline', lastSeen: now - 6 * HOUR },
];
