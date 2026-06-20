// Live swarm status — polls the agents API for the current wallet's
// activation state, per-agent heartbeat freshness, and the most recent
// intents. Powers the agent grid, the right-rail "swarm: active" badge,
// and the intents log panel.

import { useQuery } from '@tanstack/react-query';

import { useManagedAddress } from '@/hooks/useManagedAddress';
import { AGENTS_API_URL } from '@/config/swarm';
import type { SessionAgent } from '@/types/swarm';
import { isDemoFeed, buildDemoIntents, demoAgents } from '@/lib/demoFeed';
import { useDemoProfile } from '@/lib/demoProfile';

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
  /** Onchain tx hash for executed intents — pulled from the API by
   *  joining the matching `intent.executed` Event row. Undefined when
   *  the intent hasn't been mined or the event isn't yet recorded. */
  txHash?: string;
}

export type RiskProfile =
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'degen';

export interface CustomConfig {
  stableFloor?: number;
  maxToken?: number;
  maxShiftPerTick?: number;
  toleranceBps?: number;
  cadenceMinutes?: number;
}

export interface SwarmStatus {
  walletAddress: string;
  activated: boolean;
  riskProfile: RiskProfile;
  customConfig: CustomConfig | null;
  sessions: Array<{ agent: SessionAgent; sessionAddress: string; validUntil: string }>;
  agents: AgentRuntimeRow[];
  intents: IntentLogRow[];
}

const FALLBACK_AGENTS: AgentRuntimeRow[] = (
  ['pm', 'alm', 'router', 'executor'] as SessionAgent[]
).map((role) => ({ role, status: 'offline', lastSeenMs: 0, users: 0 }));

export function useSwarmStatus() {
  const owner = useManagedAddress();
  // Architecture: the EOA *is* the account (EIP-7702). Funds never move.
  const walletAddress = owner;

  const demo = isDemoFeed();
  const demoProfile = useDemoProfile();

  return useQuery<SwarmStatus>({
    queryKey: ['swarm-status', walletAddress?.toLowerCase(), demo, demoProfile],
    queryFn: async () => {
      if (!walletAddress) {
        return {
          walletAddress: '',
          activated: demo,
          riskProfile: demo ? demoProfile : 'balanced',
          customConfig: null,
          sessions: [],
          agents: demo ? demoAgents() : FALLBACK_AGENTS,
          intents: demo ? buildDemoIntents(demoProfile) : [],
        } satisfies SwarmStatus;
      }
      try {
        const res = await fetch(
          `${AGENTS_API_URL}/api/status/${walletAddress.toLowerCase()}`,
        );
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const data = (await res.json()) as SwarmStatus;
        // Demo mode: always show the synthetic feed + profile. Real intents
        // can include failed swap/x402 attempts (no funded wallet), which we
        // never want on camera. Agents/sessions stay real.
        if (demo) {
          data.intents = buildDemoIntents(demoProfile);
          data.riskProfile = demoProfile;
        }
        return data;
      } catch (err) {
        // Backend unreachable: in demo mode, still light up the feed.
        if (demo) {
          return {
            walletAddress,
            activated: true,
            riskProfile: demoProfile,
            customConfig: null,
            sessions: [],
            agents: demoAgents(),
            intents: buildDemoIntents(demoProfile),
          } satisfies SwarmStatus;
        }
        throw err;
      }
    },
    enabled: !!walletAddress || demo,
    // Poll fast enough that intent state transitions (pending → routed →
    // executed) feel instant in the UI. ~1s is the sweet spot — any
    // faster and we hammer the API with diminishing returns. SSE would
    // be the "right" answer; this is the hackathon-grade win.
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
}
