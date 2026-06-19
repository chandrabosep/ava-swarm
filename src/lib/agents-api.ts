// Thin HTTP client for the agents backend (`agents/api`).
//
// After the extension grants a Smart Sessions policy onchain, we POST
// the resulting (safeAddress, agent, sessionAddress, policyHash, validUntil)
// here so the agents' Postgres has a row to look up next tick. Without
// this call the swarm has no idea a new user just activated.

import { AGENTS_API_URL } from '@/config/swarm';
import type { SessionAgent } from '@/types/swarm';

export interface RegisterSessionInput {
  safeAddress: string;
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
  safeAddress: string,
  riskProfile: 'conservative' | 'balanced' | 'aggressive' | 'degen',
  options?: { resetCustom?: boolean },
): Promise<void> {
  const res = await fetch(
    `${AGENTS_API_URL}/api/users/${safeAddress.toLowerCase()}/profile`,
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
  safeAddress: string,
  patch: Partial<{
    stableFloor: number;
    maxToken: number;
    maxShiftPerTick: number;
    toleranceBps: number;
    cadenceMinutes: number;
  }>,
): Promise<void> {
  const res = await fetch(
    `${AGENTS_API_URL}/api/users/${safeAddress.toLowerCase()}/config`,
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

/** What the GET /api/settings/hermes endpoint returns. */
export interface HermesSettings {
  enabled: boolean;
  /** Server only confirms presence — never returns the full key. */
  hasKey: boolean;
  /** Last 4 chars of the saved key, for "is this the one I pasted?" recognition. */
  keyTail: string | null;
  model: string | null;
  baseUrl: string | null;
  skill: string | null;
  updatedAt: string | null;
}

export async function getHermesSettings(): Promise<HermesSettings> {
  const res = await fetch(`${AGENTS_API_URL}/api/settings/hermes`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getHermesSettings ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as HermesSettings;
}

/**
 * Update Hermes settings. Field semantics:
 *   - omitted / undefined → leave existing value alone
 *   - explicit `null`     → clear the stored value
 *   - string              → overwrite
 *   - `clearKey: true`    → wipe the API key (alias for `apiKey: null`)
 */
export interface HermesSettingsPatch {
  enabled?: boolean;
  apiKey?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  skill?: string | null;
  clearKey?: boolean;
}

export async function setHermesSettings(
  patch: HermesSettingsPatch,
): Promise<HermesSettings> {
  const res = await fetch(`${AGENTS_API_URL}/api/settings/hermes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`setHermesSettings ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as HermesSettings;
}
