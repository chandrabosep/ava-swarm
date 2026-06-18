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
