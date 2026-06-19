// LLM-driven allocation decision.
//
// Input:  PortfolioSnapshot + per-user risk envelope (defaults for Phase B).
// Output: AllocationIntent — target weights per symbol, with a tolerance.
//
// Provider is selected by env.llmProvider():
//   groq   — Groq's hosted Llama/Qwen/Mixtral (default). Plain JSON-mode
//            chat completion, no tool use.
//   hermes — Nous Research Hermes via Nous Portal, or any OpenAI-compatible
//            hermes-agent endpoint (HERMES_BASE_URL override). When a Skill
//            is installed via the connector, its SKILL.md is injected into
//            the system prompt and a `call_skill_api` tool is exposed so
//            the model can fetch live context before deciding. The skill's
//            API key never enters the prompt — it's attached server-side
//            in invokeCallSkillApi() to outbound requests on the skill's
//            host allowlist.
//
// The system prompt encodes:
//   - the user's risk policy (max drawdown per day, max single position, …)
//   - the universe of allowed tokens (for Phase B-1 we hardcode)
//   - the requirement to return strictly JSON in a known schema
//   - (hermes + installed skill) the SKILL.md body and host allowlist
//
// We tolerate the occasional non-JSON response by wrapping in an
// extract-JSON-from-text fallback.

import OpenAI from 'openai';

import { env, type AllocationIntent } from '@swarm/shared';
import type { PortfolioSnapshot } from './portfolio.js';
import { profileFor, type RiskProfile } from './profiles.js';
import {
  buildSkillSystemSection,
  callSkillApiTool,
  invokeCallSkillApi,
  loadInstalledSkill,
  type InstalledSkill,
} from './skill.js';

const ALLOWED_TOKENS = ['ETH', 'WBTC', 'USDC', 'UNI'] as const;
/** How many tool-call rounds we let the model run before forcing a JSON answer. */
const MAX_TOOL_TURNS = 4;

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

interface ResolvedLlm {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: 'groq' | 'hermes';
}

/**
 * Resolve which OpenAI-compatible model endpoint PM uses this tick.
 * Env-only — `LLM_PROVIDER=hermes` switches to a Hermes / Nous Portal
 * endpoint configured by HERMES_API_KEY / HERMES_BASE_URL / HERMES_MODEL.
 * Default is Groq.
 */
function resolveLlm(): ResolvedLlm {
  if (env.llmProvider() === 'hermes') {
    return {
      provider: 'hermes',
      apiKey: env.hermesApiKey(),
      baseURL: env.hermesBaseUrl(),
      model: env.hermesModel(),
    };
  }
  return {
    provider: 'groq',
    apiKey: env.groqApiKey(),
    baseURL: env.groqBaseUrl(),
    model: env.groqModel(),
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
  const llm = resolveLlm();
  const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });

  const userPrompt = buildUserPrompt(params);
  const baseSystem = buildSystemPrompt(params.riskProfile ?? 'balanced');

  // Skill use is gated on Hermes — Groq's hosted models don't get the
  // SKILL.md or the tool. (We could expose tools to Groq too, but the
  // skill-driven flow is the differentiator we're shipping for Hermes.)
  const skill = llm.provider === 'hermes' ? await loadInstalledSkill() : null;

  const text =
    skill && skill.allowedHosts.length > 0
      ? await runWithSkillTools(client, llm.model, baseSystem, userPrompt, skill)
      : await runPlainJson(client, llm.model, baseSystem, userPrompt);

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

/**
 * Skill-less path: one shot, JSON-mode response_format. Used for Groq and
 * for Hermes when no skill is installed (or the installed skill has no
 * callable hosts).
 */
async function runPlainJson(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await client.chat.completions.create({
    model,
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? '';
}

/**
 * Hermes + skill: run a tool-calling loop. The model can call the skill's
 * HTTP API a few times to gather context, then must emit the allocation
 * JSON. We bound the loop at MAX_TOOL_TURNS and on the final pass strip
 * tools + force JSON-mode so the model can't stall indefinitely.
 */
async function runWithSkillTools(
  client: OpenAI,
  model: string,
  baseSystem: string,
  user: string,
  skill: InstalledSkill,
): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: baseSystem },
    { role: 'system', content: buildSkillSystemSection(skill) },
    { role: 'user', content: user },
  ];
  const tools = [callSkillApiTool(skill)];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 1200,
      temperature: 0.3,
      tools,
      tool_choice: 'auto',
      messages,
    });
    const choice = res.choices[0];
    const msg = choice?.message;
    if (!msg) break;

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // Model produced its final answer.
      return msg.content ?? '';
    }

    // Persist the assistant's tool-call message before adding tool results.
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: calls,
    });

    // Execute all tool calls in parallel — they're independent HTTP fetches.
    const results = await Promise.all(
      calls.map((tc) =>
        tc.type === 'function' && tc.function.name === 'call_skill_api'
          ? invokeCallSkillApi(skill, tc.function.arguments)
          : Promise.resolve({
              ok: false,
              error: `unknown tool: ${tc.type === 'function' ? tc.function.name : tc.type}`,
            }),
      ),
    );
    calls.forEach((tc, i) => {
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(results[i]),
      });
    });
  }

  // Hit the turn cap — drop tools and force a JSON answer using whatever
  // context the model already gathered.
  messages.push({
    role: 'system',
    content:
      'Tool budget exhausted. Output the final allocation JSON now using the context you have.',
  });
  const final = await client.chat.completions.create({
    model,
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages,
  });
  return final.choices[0]?.message?.content ?? '';
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
