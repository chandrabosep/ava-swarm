// Live swarm status — polls /api/swarm/status every 5s.
//
// The agent backend on Railway upserts agent_state rows on every tick,
// so MAX(updated_at) grouped by role is our liveness signal. Events
// table is the activity feed.

import { useQuery } from '@tanstack/react-query';

import type { AgentRole } from '@/types';

export interface SwarmAgentLive {
  role: AgentRole;
  /** Unix ms — last time the agent wrote to agent_state. */
  lastSeen: number;
  /** Number of users currently with an unexpired session for this agent. */
  activeSessions: number;
}

export interface SwarmEvent {
  id: string;
  safeAddress: string;
  agent: AgentRole | null;
  kind: string;
  payload: unknown;
  /** Unix ms */
  createdAt: number;
}

export interface SwarmStatus {
  agents: SwarmAgentLive[];
  recentEvents: SwarmEvent[];
}

const STATUS_URL = '/api/swarm/status';

async function fetchStatus(): Promise<SwarmStatus> {
  const res = await fetch(STATUS_URL, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`swarm status ${res.status}`);
  }
  return (await res.json()) as SwarmStatus;
}

export function useSwarmStatus() {
  return useQuery({
    queryKey: ['swarm', 'status'],
    queryFn: fetchStatus,
    refetchInterval: 5_000,
    staleTime: 4_000,
    // Don't retry endlessly when the API is missing in local dev — the
    // panel falls back to "offline" cleanly without it.
    retry: 1,
  });
}

/**
 * Convert `lastSeen` to one of: busy / idle / offline based on staleness.
 * Tweak thresholds in one place.
 */
export function liveStatus(
  lastSeen: number | undefined,
): 'busy' | 'idle' | 'offline' {
  if (!lastSeen) return 'offline';
  const ageMs = Date.now() - lastSeen;
  if (ageMs < 90_000) return 'busy';
  if (ageMs < 5 * 60_000) return 'idle';
  return 'offline';
}
