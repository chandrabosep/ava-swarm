// LLM-driven allocation decision.
//
// Input:  PortfolioSnapshot + per-user risk envelope (defaults for Phase B).
// Output: AllocationIntent — target weights per symbol, with a tolerance.
//
// Provider is selected by env.llmProvider():
//   groq   — Groq's hosted Llama/Qwen/Mixtral (default).
//   hermes — Nous Research Hermes via Nous Portal, or any OpenAI-compatible
//            hermes-agent endpoint (HERMES_BASE_URL override).
//
// The system prompt encodes:
//   - the user's risk policy (max drawdown per day, max single position, …)
//   - the universe of allowed tokens (for Phase B-1 we hardcode)
//   - the requirement to return strictly JSON in a known schema
//
// We tolerate the occasional non-JSON response by wrapping in a
// extract-JSON-from-text fallback.

import OpenAI from 'openai';

import { db, env, type AllocationIntent } from '@swarm/shared';
import type { PortfolioSnapshot } from './portfolio.js';
import { profileFor, type RiskProfile } from './profiles.js';

const ALLOWED_TOKENS = ['ETH', 'WBTC', 'USDC', 'UNI'] as const;

export interface DecideParams {
  safeAddress: string;
  snapshot: PortfolioSnapshot;
  /** Soft rebalance threshold — Router only acts on diffs > this. */
  toleranceBps: number;
  /** Free-form market context (news headlines, signals). Phase B-2 will fill this. */
  context?: string;
  /** Risk profile from the User row. Drives prompt + caps. */
  riskProfile?: RiskProfile;
}

/**
 * Resolve which model client + system-prompt extension to use for THIS tick.
 *
 * Precedence (highest first):
 *   1. SwarmSettings row in Postgres with hermesEnabled=true and an
 *      hermesApiKey on file. This is what the extension's Hermes settings
 *      panel writes — paste a key in the UI and you're using Hermes
 *      without restarting PM.
 *   2. LLM_PROVIDER=hermes env var (still works for ops/CI deploys that
 *      set everything via env).
 *   3. Groq defaults.
 *
 * Returns the resolved client config plus an optional `skillSuffix` —
 * the free-form text the user pasted in the UI, appended to the system
 * prompt so the model has their custom guidance.
 */
export async function resolveLlm(): Promise<{
  apiKey: string;
  baseURL: string;
  model: string;
  provider: 'groq' | 'hermes';
  skillSuffix: string | null;
}> {
  // DB read is best-effort — if the table doesn't exist yet (pre-migration)
  // or Postgres is having a bad day we fall back to env so PM stays alive.
  let row: {
    hermesEnabled: boolean;
    hermesApiKey: string | null;
    hermesModel: string | null;
    hermesBaseUrl: string | null;
    hermesSkill: string | null;
  } | null = null;
  try {
    row = await db().swarmSettings.findUnique({ where: { id: 'global' } });
  } catch {
    row = null;
  }

  if (row?.hermesEnabled && row.hermesApiKey) {
    return {
      apiKey: row.hermesApiKey,
      baseURL: row.hermesBaseUrl ?? env.hermesBaseUrl(),
      model: row.hermesModel ?? env.hermesModel(),
      provider: 'hermes',
      skillSuffix: row.hermesSkill ?? null,
    };
  }

  if (env.llmProvider() === 'hermes') {
    return {
      apiKey: env.hermesApiKey(),
      baseURL: env.hermesBaseUrl(),
      model: env.hermesModel(),
      provider: 'hermes',
      skillSuffix: null,
    };
  }

  return {
    apiKey: env.groqApiKey(),
    baseURL: env.groqBaseUrl(),
    model: env.groqModel(),
    provider: 'groq',
    skillSuffix: null,
  };
}

function buildSystemPrompt(profile: RiskProfile): string {
  const cfg = profileFor(profile).config;
  const stablePct = Math.round(cfg.stableFloor * 100);
  const maxPct = Math.round(cfg.maxToken * 100);
  const shiftPct = Math.round(cfg.maxShiftPerTick * 100);
  return `${cfg.persona}

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
3. No single non-stable token weight > ${cfg.maxToken.toFixed(2)} (${maxPct}%).
4. Stablecoin floor (USDC) >= ${cfg.stableFloor.toFixed(2)} (${stablePct}%).
5. Move at most ${cfg.maxShiftPerTick.toFixed(2)} (${shiftPct}%) in absolute
   weight from the current allocation per tick (smooth changes).
6. Be quantitative in the rationale. Reference current weights and 24h moves.`;
}

export async function decideAllocation(
  params: DecideParams,
): Promise<AllocationIntent> {
  const llm = await resolveLlm();
  const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });

  const userPrompt = buildUserPrompt(params);
  const baseSystem = buildSystemPrompt(params.riskProfile ?? 'balanced');
  const system = llm.skillSuffix
    ? `${baseSystem}\n\nAdditional user-provided guidance (Hermes skill):\n${llm.skillSuffix}`
    : baseSystem;

  const res = await client.chat.completions.create({
    model: llm.model,
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
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
