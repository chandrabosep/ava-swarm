// LLM-driven allocation decision.
//
// Input:  PortfolioSnapshot + per-user risk envelope (defaults for Phase B).
// Output: AllocationIntent — target weights per symbol, with a tolerance.
//
// We use Groq's OpenAI-compatible API (https://console.groq.com) to run
// open-source models (default: Llama 3.3 70B). Sub-second latency, no
// rate-limiting issues at hackathon scale.
//
// The system prompt encodes:
//   - the user's risk policy (max drawdown per day, max single position, …)
//   - the universe of allowed tokens (for Phase B-1 we hardcode)
//   - the requirement to return strictly JSON in a known schema
//
// We tolerate the occasional non-JSON response by wrapping in a
// extract-JSON-from-text fallback.

import OpenAI from 'openai';

import { env, type AllocationIntent } from '@swarm/shared';
import type { PortfolioSnapshot } from './portfolio.js';

const ALLOWED_TOKENS = ['ETH', 'WBTC', 'USDC', 'UNI'] as const;

export interface DecideParams {
  safeAddress: string;
  snapshot: PortfolioSnapshot;
  /** Soft rebalance threshold — Router only acts on diffs > this. */
  toleranceBps: number;
  /** Free-form market context (news headlines, signals). Phase B-2 will fill this. */
  context?: string;
}

const SYSTEM = `You are a conservative DeFi portfolio manager agent.

Your job is to propose a target allocation across the allowed token
universe given the user's current portfolio. You output JSON ONLY,
matching this schema:

{
  "rationale": "<2-3 sentence explanation>",
  "targets": [
    { "symbol": "ETH",  "weight": 0.40 },
    { "symbol": "USDC", "weight": 0.45 },
    { "symbol": "WBTC", "weight": 0.15 }
  ]
}

Rules:
1. Allowed symbols: ${ALLOWED_TOKENS.join(', ')}.
2. weights sum to exactly 1.0.
3. No single token weight > 0.6.
4. Stablecoin floor (USDC) >= 0.20 unless user is explicitly aggressive.
5. Move at most 0.20 in absolute weight from the current allocation per
   tick (smooth changes).
6. Be quantitative in the rationale. Reference current weights and
   24h moves you observed.`;

export async function decideAllocation(
  params: DecideParams,
): Promise<AllocationIntent> {
  const client = new OpenAI({
    apiKey: env.groqApiKey(),
    baseURL: env.groqBaseUrl(),
  });

  const userPrompt = buildUserPrompt(params);

  const res = await client.chat.completions.create({
    model: env.groqModel(),
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = res.choices[0]?.message?.content ?? '';
  const parsed = extractJson(text) as {
    rationale?: string;
    targets?: Array<{ symbol: string; weight: number }>;
  };

  if (!parsed.targets || parsed.targets.length === 0) {
    throw new Error(`PM LLM returned no targets: ${text.slice(0, 200)}`);
  }

  // Defensive normalization — clamp to allowed universe, renormalize sum.
  const filtered = parsed.targets.filter((t) =>
    (ALLOWED_TOKENS as readonly string[]).includes(t.symbol),
  );
  const sum = filtered.reduce((s, t) => s + t.weight, 0);
  const targets =
    sum > 0
      ? filtered.map((t) => ({ symbol: t.symbol, weight: t.weight / sum }))
      : [];

  return {
    kind: 'allocation',
    targets,
    toleranceBps: params.toleranceBps,
  };
}

function buildUserPrompt(params: DecideParams): string {
  const { snapshot, safeAddress, toleranceBps, context } = params;
  const lines = [
    `Safe address: ${safeAddress}`,
    `Total value: $${snapshot.totalValueUsd.toFixed(2)}`,
    `24h change: ${snapshot.change24hPct.toFixed(2)}% ($${snapshot.change24hUsd.toFixed(2)})`,
    `Tolerance: ${(toleranceBps / 100).toFixed(2)}% — ignore deltas smaller than this.`,
    '',
    'Current positions:',
    ...snapshot.positions.map(
      (p) =>
        `  ${p.symbol.padEnd(6)} ${(p.weight * 100).toFixed(1).padStart(5)}%  $${p.valueUsd.toFixed(2).padStart(10)}  24h ${p.change24hPct.toFixed(2)}%`,
    ),
  ];
  if (context) {
    lines.push('', 'Market context:', context);
  }
  return lines.join('\n');
}

/** Find the first {...} JSON object in a string. Tolerates prose around it. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object in PM response');
  }
  return JSON.parse(text.slice(start, end + 1));
}
