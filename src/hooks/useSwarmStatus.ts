// Live swarm status — polls the agents API for the current Safe's
// activation state, per-agent heartbeat freshness, and the most recent
// intents. Powers the agent grid, the right-rail "swarm: active" badge,
// and the intents log panel.

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';

import { AGENTS_API_URL } from '@/config/swarm';
import type { SessionAgent } from '@/types/swarm';

export type AgentLiveStatus = 'online' | 'idle' | 'offline';

export interface AgentRuntimeRow {
  role: SessionAgent;
  status: AgentLiveStatus;
  lastSeenMs: number;
  users: number;
}

export interface IntentLogRow {
  id: string;
  fromAgent: SessionAgent;
  status: string;
  payload: unknown;
  createdAt: string;
}

export interface SwarmStatus {
  safeAddress: string;
  activated: boolean;
  sessions: Array<{ agent: SessionAgent; sessionAddress: string; validUntil: string }>;
  agents: AgentRuntimeRow[];
  intents: IntentLogRow[];
}

const FALLBACK_AGENTS: AgentRuntimeRow[] = (
  ['pm', 'alm', 'router', 'executor'] as SessionAgent[]
).map((role) => ({ role, status: 'offline', lastSeenMs: 0, users: 0 }));

export function useSwarmStatus() {
  const { address: owner } = useAccount();
  // Architecture: the EOA *is* the account (EIP-7702). Funds never move.
  const safeAddress = owner;

  return useQuery<SwarmStatus>({
    queryKey: ['swarm-status', safeAddress?.toLowerCase()],
    queryFn: async () => {
      if (!safeAddress) {
        return {
          safeAddress: '',
          activated: false,
          sessions: [],
          agents: FALLBACK_AGENTS,
          intents: [],
        };
      }
      const res = await fetch(
        `${AGENTS_API_URL}/api/status/${safeAddress.toLowerCase()}`,
      );
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      return (await res.json()) as SwarmStatus;
    },
    enabled: !!safeAddress,
    // Poll fast enough that intent state transitions (pending → routed →
    // executed) feel instant in the UI. ~1s is the sweet spot — any
    // faster and we hammer the API with diminishing returns. SSE would
    // be the "right" answer; this is the hackathon-grade win.
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
}
