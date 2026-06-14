// All mock data lives here so it's trivial to delete the moment we wire real
// agent runtime / portfolio / news sources.

import type {
  Agent,
  AgentRole,
  Intent,
  NewsItem,
  PortfolioSummary,
} from '@/types';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
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

export const mockPortfolio: PortfolioSummary = {
  totalValueUsd: 124_530.42,
  change24hUsd: 1_842.17,
  change24hPct: 0.0151,
  allocations: [
    { symbol: 'ETH', pct: 0.42, valueUsd: 52_302.78 },
    { symbol: 'USDC', pct: 0.28, valueUsd: 34_868.52 },
    { symbol: 'WBTC', pct: 0.18, valueUsd: 22_415.48 },
    { symbol: 'UNI', pct: 0.07, valueUsd: 8_717.13 },
    { symbol: 'Other', pct: 0.05, valueUsd: 6_226.51 },
  ],
};

export const mockIntents: Intent[] = [
  {
    id: 'intent-001',
    from: 'pm',
    tokenIn: 'USDC',
    tokenOut: 'ETH',
    amount: '5,000',
    createdAt: now - 4 * MINUTE,
    status: 'pending',
  },
  {
    id: 'intent-002',
    from: 'alm',
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    amount: '1.42',
    createdAt: now - 12 * MINUTE,
    status: 'netted',
  },
  {
    id: 'intent-003',
    from: 'router',
    tokenIn: 'WBTC',
    tokenOut: 'USDC',
    amount: '0.08',
    createdAt: now - 38 * MINUTE,
    status: 'routed',
  },
  {
    id: 'intent-004',
    from: 'executor',
    tokenIn: 'USDC',
    tokenOut: 'UNI',
    amount: '750',
    createdAt: now - 2 * HOUR,
    status: 'executed',
  },
];

export const mockNews: NewsItem[] = [
  {
    id: 'news-001',
    title: 'Uniswap v4 hooks ship to mainnet — early TVL ramps faster than v3',
    source: 'The Defiant',
    url: 'https://thedefiant.io/uniswap-v4',
    tags: ['Uniswap', 'v4', 'Hooks'],
    publishedAt: now - 35 * MINUTE,
  },
  {
    id: 'news-002',
    title: 'Unichain throughput hits new high after sequencer upgrade',
    source: 'Unichain Blog',
    url: 'https://blog.uniswap.org/unichain',
    tags: ['Unichain', 'L2', 'Performance'],
    publishedAt: now - 2 * HOUR,
  },
  {
    id: 'news-003',
    title: 'Permit2 adoption crosses 60% of EVM swap volume',
    source: 'Dune',
    url: 'https://dune.com/permit2',
    tags: ['Permit2', 'Approvals'],
    publishedAt: now - 5 * HOUR,
  },
  {
    id: 'news-004',
    title: 'Base announces new fee-rebate program for active LPs',
    source: 'Base',
    url: 'https://base.org/blog',
    tags: ['Base', 'LP', 'Incentives'],
    publishedAt: now - 8 * HOUR,
  },
  {
    id: 'news-005',
    title: 'Gensyn AXL testnet opens — agent-to-agent comms primitives',
    source: 'Gensyn',
    url: 'https://gensyn.ai/axl',
    tags: ['Gensyn', 'AXL', 'Agents'],
    publishedAt: now - 18 * HOUR,
  },
];
