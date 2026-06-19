// Thin HTTP client for the agents backend (`agents/api`).
//
// After the extension grants a delegation policy onchain (EIP-7702),
// we POST the resulting (walletAddress, agent, sessionAddress,
// policyHash, validUntil) here so the agents' Postgres has a row to
// look up next tick. Without this call the swarm has no idea a new
// user just activated.

import { AGENTS_API_URL } from '@/config/swarm';
import { getAuthHeaders } from '@/lib/agents-auth';
import type { SessionAgent } from '@/types/swarm';

/** Compose JSON + auth headers for write requests. The wallet popup
 *  fires only on the first call after a signer registers and after the
 *  4-minute cache expires. */
async function authedJsonHeaders(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    ...(await getAuthHeaders()),
  };
}

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
    headers: await authedJsonHeaders(),
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
      headers: await authedJsonHeaders(),
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
      headers: await authedJsonHeaders(),
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
// Per-agent skill installs. The user pastes (or links) a SKILL.md and
// picks an agent role; the server discovers the register/status
// endpoints from the markdown, self-registers (POST .../agents/register
// with `{name: DefiSwarm-PM, description: ...}`), and persists the
// returned api_key + claim_url + verification_code. The human visits
// claim_url to complete verification on the skill's own site.
//
// `apiKey` is server-only — the wire shape carries `hasApiKey` + `keyTail`
// so the UI can render "••••a3f2" without seeing the secret.

export type AgentRole = 'pm' | 'alm' | 'router' | 'executor';

export type ClaimStatus = 'unknown' | 'pending_claim' | 'claimed' | 'failed' | string;

export interface InstalledSkillWire {
  id: string;
  agentRole: AgentRole;
  name: string;
  version: string | null;
  description: string | null;
  sourceUrl: string | null;
  contentHash: string;
  contentLength: number;
  /** Hosts the PM tool-call loop is allowed to hit on this skill's behalf. */
  allowedHosts: string[];
  apiBase: string | null;
  registerEndpoint: string | null;
  statusEndpoint: string | null;
  hasApiKey: boolean;
  keyTail: string | null;
  /** Renderable: render a "Claim your agent" button when set + status=pending_claim. */
  claimUrl: string | null;
  /** Renderable: small text below the claim URL ("verification code: reef-X4B2"). */
  verificationCode: string | null;
  claimStatus: ClaimStatus;
  lastHeartbeatAt: string | null;
  registeredName: string | null;
  installedAt: string;
  updatedAt: string;
}

export async function listSkills(): Promise<InstalledSkillWire[]> {
  const res = await fetch(`${AGENTS_API_URL}/api/skills`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`listSkills ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as { skills: InstalledSkillWire[] };
  return json.skills;
}

export interface InstallSkillInput {
  /** Either inline markdown… */
  content?: string;
  /** …or a URL to fetch the SKILL.md from. */
  sourceUrl?: string;
  agentRole: AgentRole;
}

/**
 * Install + auto-register a skill. Atomic on the server: a 4xx upstream
 * response leaves no half-installed row to clean up.
 */
export async function installSkill(
  input: InstallSkillInput,
): Promise<InstalledSkillWire> {
  const res = await fetch(`${AGENTS_API_URL}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let body: { skill?: InstalledSkillWire; error?: string; upstreamStatus?: number } = {};
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`installSkill ${res.status}: ${text || res.statusText}`);
  }
  if (!res.ok || !body.skill) {
    const upstream = body.upstreamStatus ? ` (upstream ${body.upstreamStatus})` : '';
    throw new Error(`${body.error ?? `installSkill ${res.status}`}${upstream}`);
  }
  return body.skill;
}

export async function uninstallSkill(skillId: string): Promise<void> {
  const res = await fetch(`${AGENTS_API_URL}/api/skills/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`uninstallSkill ${res.status}: ${text || res.statusText}`);
  }
}

/**
 * Force one heartbeat sweep across all installed skills, then return
 * the latest row for `skillId`. Used by the connector card to give
 * users an immediate "I just claimed, did it work?" affordance.
 */
export async function refreshSkillStatus(
  skillId: string,
): Promise<InstalledSkillWire> {
  const res = await fetch(
    `${AGENTS_API_URL}/api/skills/${encodeURIComponent(skillId)}/refresh-status`,
    { method: 'POST' },
  );
  const text = await res.text();
  let body: { skill?: InstalledSkillWire; error?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`refreshSkillStatus ${res.status}: ${text || res.statusText}`);
  }
  if (!res.ok || !body.skill) {
    throw new Error(body.error ?? `refreshSkillStatus ${res.status}`);
  }
  return body.skill;
}

// =====================================================================
// Hermes connectivity test
// =====================================================================

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

/**
 * Pings the configured Hermes endpoint with a one-token completion to
 * verify HERMES_API_KEY / HERMES_BASE_URL / HERMES_MODEL are reachable
 * and authorized. Server returns structured JSON for both success (200)
 * and the expected failure modes (400 missing key, 502 upstream error).
 */
export async function testHermes(): Promise<HermesTestResult> {
  const res = await fetch(`${AGENTS_API_URL}/api/hermes/test`, {
    method: 'POST',
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as HermesTestResult;
  } catch {
    throw new Error(`testHermes ${res.status}: ${text || res.statusText}`);
  }
}
