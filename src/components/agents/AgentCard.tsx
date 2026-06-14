import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/mock';
import { formatRelative } from '@/lib/format';
import type { Agent, AgentStatus } from '@/types';

const STATUS_TONE: Record<AgentStatus, 'neutral' | 'accent' | 'positive'> = {
  offline: 'neutral',
  idle: 'accent',
  busy: 'positive',
};

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <Surface variant="raised" className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-fg-subtle">
            {agent.role.toUpperCase()}
          </div>
          <div className="mt-1 font-semibold text-fg leading-tight">
            {ROLE_LABELS[agent.role]}
          </div>
        </div>
        <Badge tone={STATUS_TONE[agent.status]} dot>
          {agent.status}
        </Badge>
      </div>

      <p className="text-xs text-fg-muted leading-relaxed">
        {ROLE_DESCRIPTIONS[agent.role]}
      </p>

      <div className="mt-auto flex items-center justify-between text-[11px] text-fg-subtle">
        <span className="font-mono">{agent.id}</span>
        <span>last seen {formatRelative(agent.lastSeen)}</span>
      </div>
    </Surface>
  );
}
