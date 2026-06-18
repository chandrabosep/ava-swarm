import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/mock';
import { formatRelative } from '@/lib/format';
import { useSwarmStatus } from '@/hooks/useSwarmStatus';
import { shortAddress } from '@/lib/format';
import type { Agent, AgentRole, AgentStatus } from '@/types';

const STATUS_TONE: Record<AgentStatus, 'neutral' | 'accent' | 'positive'> = {
  offline: 'neutral',
  idle: 'accent',
  busy: 'positive',
  online: 'positive',
};

/** Roles that need an onchain session key. PM/Router stay offchain. */
const NEEDS_SESSION: ReadonlySet<AgentRole> = new Set(['alm', 'executor']);

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  const status = useSwarmStatus();

  // Session granted = the agents API has a Session row for this agent on
  // the user's current wallet. Live demo mode + real grants both flow
  // through the same path.
  const sessionRow = status.data?.sessions.find((s) => s.agent === agent.role);
  const sessionKey = sessionRow?.sessionAddress as
    | `0x${string}`
    | undefined;
  const needsSession = NEEDS_SESSION.has(agent.role);
  const granted = needsSession && !!sessionKey;

  // "Thinking" — the agent did something within the last 5 seconds.
  // Drives a soft animated halo so the card visibly pulses when this
  // agent is actively working (not just heartbeating).
  const lastIntent = status.data?.intents?.find(
    (i) => i.fromAgent === agent.role,
  );
  const ageSec = lastIntent
    ? (Date.now() - new Date(lastIntent.createdAt).getTime()) / 1000
    : Infinity;
  const isThinking = ageSec < 5;

  return (
    <Surface
      variant="raised"
      className={`p-4 flex flex-col gap-3 transition-all ${
        isThinking
          ? 'ring-2 ring-positive/40 shadow-[0_0_20px_-4px_rgba(34,197,94,0.4)]'
          : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-fg-subtle">
            {agent.role.toUpperCase()}
          </div>
          <div className="mt-1 font-semibold text-fg leading-tight">
            {ROLE_LABELS[agent.role]}
          </div>
        </div>
        <Badge
          tone={STATUS_TONE[agent.status]}
          dot
          className={
            agent.status === 'online' || agent.status === 'busy'
              ? 'animate-pulse-soft'
              : undefined
          }
        >
          {isThinking ? 'thinking…' : agent.status}
        </Badge>
      </div>

      <p className="text-xs text-fg-muted leading-relaxed">
        {ROLE_DESCRIPTIONS[agent.role]}
      </p>

      {/* Session key status — only for agents that need one. */}
      {needsSession && (
        <div className="text-[11px] text-fg-subtle border-t border-border-subtle pt-2">
          {granted ? (
            <span>
              session:{' '}
              <span className="font-mono text-fg-muted">
                {shortAddress(sessionKey!)}
              </span>{' '}
              · granted
            </span>
          ) : (
            <span>session: not granted</span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between text-[11px] text-fg-subtle">
        <span className="font-mono">{agent.id}</span>
        <span>last seen {formatRelative(agent.lastSeen)}</span>
      </div>
    </Surface>
  );
}
