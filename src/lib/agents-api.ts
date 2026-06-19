// Thin HTTP client for the agents backend (`agents/api`).
//
// After the extension grants a delegation policy onchain (EIP-7702),
// we POST the resulting (walletAddress, agent, sessionAddress,
// policyHash, validUntil) here so the agents' Postgres has a row to
// look up next tick. Without this call the swarm has no idea a new
// user just activated.

import { AGENTS_API_URL } from '@/config/swarm';
import type { SessionAgent } from '@/types/swarm';

export interface RegisterSessionInput {
  walletAddress: string;
  ownerEoa: string;
  agent: SessionAgent;
  sessionAddress: string;
  policyHash: string;
  /** Unix seconds. */
  validUntil: number;
  /** Comma-joined chain list ("base,unichain"). */
  chains?: string;
  txHash?: string;
}

export async function registerSession(input: RegisterSessionInput): Promise<void> {
  const res = await fetch(`${AGENTS_API_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`registerSession ${res.status}: ${text || res.statusText}`);
  }
}

export async function setRiskProfile(
  walletAddress: string,
  riskProfile: 'conservative' | 'balanced' | 'aggressive' | 'degen',
  options?: { resetCustom?: boolean },
): Promise<void> {
  const res = await fetch(
    `${AGENTS_API_URL}/api/users/${walletAddress.toLowerCase()}/profile`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskProfile, resetCustom: options?.resetCustom }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`setRiskProfile ${res.status}: ${text || res.statusText}`);
  }
}

export async function setCustomConfig(
  walletAddress: string,
  patch: Partial<{
    stableFloor: number;
    maxToken: number;
    maxShiftPerTick: number;
    toleranceBps: number;
    cadenceMinutes: number;
  }>,
): Promise<void> {
  const res = await fetch(
    `${AGENTS_API_URL}/api/users/${walletAddress.toLowerCase()}/config`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`setCustomConfig ${res.status}: ${text || res.statusText}`);
  }
}

// =====================================================================
// Skill connector
// =====================================================================
//
// Hermes-Agent style: the swarm stores one installed skill (markdown
// describing some service's API) plus the API key for that service.
// The full content + key never come back to the UI — only metadata
// (parsed name/version/description) and `keyTail`.

export interface SkillState {
  hasSkill: boolean;
  hasKey: boolean;
  keyTail: string | null;
  name: string | null;
  version: string | null;
  description: string | null;
  contentLength: number;
  installedAt: string | null;
  updatedAt: string | null;
  /** Hosts the PM tool-call loop is allowed to hit on the skill's behalf. */
  allowedHosts: string[];
  /** Which LLM provider PM is currently configured to use. */
  llmProvider: 'groq' | 'hermes';
  /** True when HERMES_API_KEY is set on the agents server. */
  hermesConfigured: boolean;
  hermesModel: string | null;
  hermesBaseUrl: string | null;
  /**
   * True when all the conditions for the PM to actually use the skill are
   * met (provider=hermes, content+key installed, ≥1 callable host). Drives
   * the "live in PM" pill in the connector card.
   */
  pmActive: boolean;
}

export async function getSkill(): Promise<SkillState> {
  const res = await fetch(`${AGENTS_API_URL}/api/skill`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getSkill ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as SkillState;
}

/**
 * Patch the installed skill. Field semantics:
 *   undefined → leave alone, null → clear, string → overwrite.
 *   `clearKey: true` is an alias for `apiKey: null`.
 *
 * Pasting `content` triggers a server-side YAML-frontmatter parse so the
 * UI's "installed: <name> v<version>" line stays in sync without the
 * client needing to re-parse.
 */
export interface SkillPatch {
  content?: string | null;
  apiKey?: string | null;
  clearKey?: boolean;
}

export async function setSkill(patch: SkillPatch): Promise<SkillState> {
  const res = await fetch(`${AGENTS_API_URL}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as
    | SkillState
    | { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `setSkill ${res.status}`);
  }
  return data as SkillState;
}

export async function clearSkill(): Promise<void> {
  const res = await fetch(`${AGENTS_API_URL}/api/skill`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`clearSkill ${res.status}: ${text || res.statusText}`);
  }
}

// =====================================================================
// Hermes connection test
// =====================================================================
//
// Pings the configured Hermes endpoint with a one-token chat completion
// and reports back. Used by the connector card's "Test Hermes" button so
// users can verify their HERMES_* env vars work without waiting for a PM
// tick to fail.

export interface HermesTestResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  model?: string | null;
  baseUrl?: string | null;
  /** Trimmed content of the model's reply. Only populated on success. */
  sample?: string | null;
  /** Upstream error message (truncated server-side) when ok=false. */
  error?: string;
  /** Optional human hint for the most common misconfig. */
  hint?: string;
}

export async function testHermes(): Promise<HermesTestResult> {
  const res = await fetch(`${AGENTS_API_URL}/api/hermes/test`, {
    method: 'POST',
  });
  // The server returns structured JSON for both success (200) and the
  // expected failure modes (400 missing key, 502 upstream error). Pass
  // those through verbatim. Only fall through to a thrown Error on a
  // genuine non-JSON response (e.g. Express 5xx from elsewhere).
  const text = await res.text();
  try {
    return JSON.parse(text) as HermesTestResult;
  } catch {
    throw new Error(`testHermes ${res.status}: ${text || res.statusText}`);
  }
}
