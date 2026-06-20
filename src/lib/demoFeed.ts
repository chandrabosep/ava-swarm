// Frontend-only demo feed.
//
// Populates the Agent Feed with a synthetic PM → Router → Executor story
// so the dashboard demos cleanly with NO backend, database, network, or
// funded wallet. Gated behind VITE_DEMO_FEED — set it to `true` in .env
// for a guaranteed-live feed; leave it unset/false to show only real
// swarm activity.
//
// When enabled, useSwarmStatus injects these rows whenever the real API
// returns no intents (or is unreachable). As soon as the live swarm
// produces its own intents, those take over automatically.

import type {
  IntentLogRow,
  AgentRuntimeRow,
  RiskProfile,
} from '@/hooks/useSwarmStatus';
import type { MarketplaceData } from '@/hooks/useMarketplace';
import type { SessionAgent } from '@/types/swarm';
import type {
  ZerionPosition,
  ZerionPositionsResponse,
  ZerionPortfolioResponse,
} from '@/types/zerion';

export function isDemoFeed(): boolean {
  return String(import.meta.env.VITE_DEMO_FEED ?? '').toLowerCase() === 'true';
}

// Avalanche Fuji token addresses — resolved to symbols by the feed's
// ADDR_SYMBOL map so the routed row shows "USDC → WAVAX".
const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const FUJI_WAVAX = '0xd00ae08403b9bbb9124bb305c09058e32c39a48c';

// Per-tick rotating tx hash so the feed's links/blocks visibly change over
// time (illustrative — won't resolve on Snowtrace unless replaced with real
// settlement hashes).
function rotTx(phase: number): `0x${string}` {
  const seed = (phase % 256).toString(16).padStart(2, '0');
  return ('0x' + seed.repeat(32)).slice(0, 66) as `0x${string}`;
}

const ROLES: SessionAgent[] = ['pm', 'alm', 'router', 'executor'];

// ---------------------------------------------------------------------------
// Per-profile strategy plans — drive the feed, allocation, and stable ratio.
// Switching the Risk Profile card re-points every demo surface at one of these.

const PRICES: Record<string, number> = {
  AVAX: 27.41,
  USDC: 1,
  DAI: 1,
  UNI: 8.12,
};
const NAMES: Record<string, string> = {
  AVAX: 'Avalanche',
  USDC: 'USD Coin',
  DAI: 'Dai Stablecoin',
  UNI: 'Uniswap',
};

interface ProfilePlan {
  targets: Array<{ symbol: string; weight: number }>;
  rationale: string;
  /** USD size of the most recent USDC→WAVAX rebalance leg. */
  routedUsd: number;
  /** Demo re-tick cadence (seconds) — how often the feed "re-decides". */
  cadenceSecs: number;
}

const PROFILE_PLANS: Record<RiskProfile, ProfilePlan> = {
  conservative: {
    targets: [
      { symbol: 'USDC', weight: 0.4 },
      { symbol: 'AVAX', weight: 0.3 },
      { symbol: 'DAI', weight: 0.2 },
      { symbol: 'UNI', weight: 0.1 },
    ],
    rationale:
      'Capital-preservation mode: holding a 60% stable floor (USDC + DAI) ' +
      'with a measured 30% AVAX / 10% UNI tilt. Only rebalancing on >10% ' +
      'drift, hourly cadence.',
    routedUsd: 1.2,
    cadenceSecs: 16,
  },
  balanced: {
    targets: [
      { symbol: 'AVAX', weight: 0.5 },
      { symbol: 'USDC', weight: 0.2 },
      { symbol: 'DAI', weight: 0.2 },
      { symbol: 'UNI', weight: 0.1 },
    ],
    rationale:
      'Treasury was 100% USDC (risk-off) against a 20% stable target. ' +
      'Deploying ~80% into the AVAX/DAI/UNI universe to close the drift, ' +
      'holding a 20% stable floor for the next tick.',
    routedUsd: 3.54,
    cadenceSecs: 12,
  },
  aggressive: {
    targets: [
      { symbol: 'AVAX', weight: 0.65 },
      { symbol: 'UNI', weight: 0.25 },
      { symbol: 'USDC', weight: 0.05 },
      { symbol: 'DAI', weight: 0.05 },
    ],
    rationale:
      'Growth tilt: cutting stables to ~10% and concentrating 65% AVAX / ' +
      '25% UNI. Tighter 2% drift band on a 5-min cadence — chasing momentum ' +
      'while capping any single token at 70%.',
    routedUsd: 4.8,
    cadenceSecs: 8,
  },
  degen: {
    targets: [
      { symbol: 'AVAX', weight: 0.92 },
      { symbol: 'UNI', weight: 0.08 },
    ],
    rationale:
      'No stable floor. Max momentum: ~92% AVAX, rotating the remainder ' +
      'through UNI. 1% drift trigger, 1-min cadence — full send.',
    routedUsd: 6.1,
    cadenceSecs: 5,
  },
};

/** All four agents reported online — used only when the backend is
 *  unreachable so the right-rail still reads "swarm: active". */
export function demoAgents(): AgentRuntimeRow[] {
  const now = Date.now();
  return ROLES.map((role) => ({
    role,
    status: 'online' as const,
    lastSeenMs: now,
    users: 1,
  }));
}

// One PM → Router → Executor batch for a given tick (newest-first within
// the batch: PM decision on top, then its routed leg + receipt).
function makeBatch(
  profile: RiskProfile,
  phase: number,
  nowMs: number,
): IntentLogRow[] {
  const plan = PROFILE_PLANS[profile];
  const ago = (secs: number) => new Date(nowMs - secs * 1000).toISOString();
  const tx = rotTx(phase);
  const idp = `demo-${profile}-${phase}`;

  return [
    {
      id: `${idp}-pm`,
      fromAgent: 'pm',
      status: 'routed',
      createdAt: ago(0),
      payload: {
        kind: 'allocation',
        profile,
        targets: plan.targets,
        rationale: plan.rationale,
      },
    },
    {
      id: `${idp}-router`,
      fromAgent: 'router',
      status: 'executed',
      createdAt: ago(3),
      txHash: tx,
      payload: {
        kind: 'routed',
        chain: 'avalanche-fuji',
        venue: 'uniswap',
        tokenIn: FUJI_USDC,
        tokenOut: FUJI_WAVAX,
        amountIn: String(Math.round(plan.routedUsd * 1e6)),
        notionalUsd: plan.routedUsd,
        origin: 'pm',
      },
    },
    {
      id: `${idp}-exec`,
      fromAgent: 'executor',
      status: 'executed',
      createdAt: ago(6),
      payload: {
        kind: 'receipt',
        status: 'mined',
        txHash: tx,
        blockNumber: String(38214900 + phase),
      },
    },
  ];
}

// Accumulating feed history — a real activity log that GROWS over time
// instead of overwriting the same rows. A fresh batch is appended on the
// top each time the profile's cadence elapses, or immediately when the
// profile changes. Capped so the feed stays bounded.
const FEED_CAP = 24;
let feedHistory: IntentLogRow[] = [];
let lastBatchKey = '';

/**
 * Newest-first feed for the given profile. Appends a new PM→Router→Executor
 * batch whenever a new tick (cadence boundary) or a profile change occurs;
 * otherwise returns the running history so older entries persist and age.
 */
export function buildDemoIntents(profile: RiskProfile = 'balanced'): IntentLogRow[] {
  const nowMs = Date.now();
  const phase = Math.floor(nowMs / 1000 / PROFILE_PLANS[profile].cadenceSecs);
  const key = `${profile}:${phase}`;

  if (key !== lastBatchKey) {
    lastBatchKey = key;
    feedHistory = [...makeBatch(profile, phase, nowMs), ...feedHistory].slice(
      0,
      FEED_CAP,
    );
  }
  // Return a fresh array reference so consumers re-render on append.
  return [...feedHistory];
}

// ---------------------------------------------------------------------------
// Agent Marketplace — the "agents that hire agents" centerpiece.

// Illustrative Fuji addresses / tx hashes for the demo (Snowtrace links are
// for visual completeness; swap in real ones for a fully-live demo).
const DEMO_REPUTATION_REGISTRY =
  '0x9a7C4f12bE3D5a8019Fc2B6e4D71a0c83F5e6b27';
const DEMO_IDENTITY_REGISTRY =
  '0x4Bd2e9F03c71A65580E12cB7a9D4f3e8C1602b94';
const payTo = (tag: string) =>
  ('0x' + tag.repeat(40)).slice(0, 42).toLowerCase();
const fakeTx = (seed: string) =>
  ('0x' + seed.repeat(64)).slice(0, 66);

const DEMO_SPECIALISTS = [
  {
    role: 'price',
    label: 'Data Oracle',
    description: 'Spot prices for AVAX / DAI / UNI on Fuji',
    path: '/price',
    tag: 'price',
    price: '0.005 USDC',
    pay: payTo('a'),
    agentId: 4,
    baseScore: 93,
    result: { price: 27.41 } as unknown,
  },
  {
    role: 'router',
    label: 'Route Analyst',
    description: 'Best-route quoting across Fuji DEX venues',
    path: '/quote-route',
    tag: 'quote-route',
    price: '0.01 USDC',
    pay: payTo('b'),
    agentId: 2,
    baseScore: 88,
    result: { route: 'USDC→WAVAX' } as unknown,
  },
  {
    role: 'alm',
    label: 'Risk Checker',
    description: 'Pre-trade slippage + exposure risk checks',
    path: '/risk-check',
    tag: 'risk-check',
    price: '0.02 USDC',
    pay: payTo('c'),
    agentId: 3,
    baseScore: 79,
    result: { verdict: 'within-limits' } as unknown,
  },
];

export function buildDemoMarketplace(): MarketplaceData {
  const now = Date.now();
  const ago = (secs: number) => new Date(now - secs * 1000).toISOString();

  // A busy, all-successful payment feed: cycle the specialists so the panel
  // reads like a live stream of x402 settlements + ERC-8004 feedback.
  const hires = Array.from({ length: 12 }, (_, i) => {
    const s = DEMO_SPECIALISTS[i % DEMO_SPECIALISTS.length];
    const score = Math.min(99, s.baseScore + 2 - Math.floor(i / 3));
    return {
      ts: ago(18 + i * 21),
      specialist: s.tag,
      label: s.label,
      tag: s.tag,
      agentId: s.agentId,
      price: s.price,
      payTo: s.pay,
      ok: true,
      score,
      repBefore: score - 3,
      payTxHash: fakeTx(String((i % 9) + 1)),
      feedbackTx: fakeTx(String(((i + 4) % 9) + 1)),
      result: s.result,
      error: null,
    };
  });

  return {
    network: 'avalanche-fuji',
    facilitator: 'facilitator.ultravioletadao.xyz',
    marketplaceUrl: 'http://localhost:8788',
    identityRegistry: DEMO_IDENTITY_REGISTRY,
    reputationRegistry: DEMO_REPUTATION_REGISTRY,
    specialists: DEMO_SPECIALISTS.map((s) => ({
      role: s.role,
      label: s.label,
      description: s.description,
      path: s.path,
      price: s.price,
      payTo: s.pay,
      agentId: s.agentId,
      reputation: {
        count: 8 + s.agentId * 3,
        avgScore: s.baseScore,
      },
    })),
    hires,
  };
}

// ---------------------------------------------------------------------------
// Portfolio — make Allocation + summary cards reflect a swarm that just
// deployed from 100% USDC into the balanced AVAX/USDC/DAI/UNI target. Totals
// stay consistent with the feed's $3.54 USDC→WAVAX leg (a ~$7.6 treasury).

const FUJI = 'avalanche-fuji';

// Treasury size stays constant across profiles (only the mix changes), so the
// Total Value card is stable while the Allocation + Stable Ratio shift.
const DEMO_TOTAL = 7.59;

interface DemoToken {
  symbol: string;
  name: string;
  value: number; // USD
  price: number; // USD per unit
  change1d: number; // USD
}

function makePosition(t: DemoToken): ZerionPosition {
  const qty = t.value / t.price;
  return {
    type: 'positions',
    id: `demo-${t.symbol.toLowerCase()}`,
    attributes: {
      name: t.name,
      quantity: {
        int: String(Math.round(qty)),
        decimals: 18,
        float: qty,
        numeric: qty.toFixed(6),
      },
      value: t.value,
      price: t.price,
      changes: {
        absolute_1d: t.change1d,
        percent_1d: t.value > 0 ? t.change1d / t.value : 0,
      },
      fungible_info: {
        name: t.name,
        symbol: t.symbol,
        icon: { url: null },
        implementations: [
          { chain_id: FUJI, address: null, decimals: 18 },
        ],
      },
      flags: { displayable: true, is_trash: false },
      position_type: 'wallet',
    },
    relationships: {
      chain: { data: { type: 'chains', id: FUJI } },
    },
  };
}

export function buildDemoPositions(
  profile: RiskProfile = 'balanced',
): ZerionPositionsResponse {
  const plan = PROFILE_PLANS[profile];
  const data = plan.targets
    .filter((t) => t.weight > 0)
    .map((t) =>
      makePosition({
        symbol: t.symbol,
        name: NAMES[t.symbol] ?? t.symbol,
        value: Number((t.weight * DEMO_TOTAL).toFixed(2)),
        price: PRICES[t.symbol] ?? 1,
        change1d: 0,
      }),
    );
  return { data };
}

export function buildDemoPortfolio(): ZerionPortfolioResponse {
  return {
    data: {
      type: 'portfolios',
      id: 'demo',
      attributes: {
        positions_distribution_by_type: {
          wallet: DEMO_TOTAL,
          deposited: 0,
          borrowed: 0,
          locked: 0,
          staked: 0,
        },
        positions_distribution_by_chain: { [FUJI]: DEMO_TOTAL },
        total: { positions: DEMO_TOTAL },
        changes: { absolute_1d: 0.08, percent_1d: 0.01 },
      } as ZerionPortfolioResponse['data']['attributes'],
    } as ZerionPortfolioResponse['data'],
  };
}
