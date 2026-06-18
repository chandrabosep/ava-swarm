import { AgentCard } from './AgentCard';
import { useSwarmStatus, liveStatus } from '@/hooks/useSwarmStatus';
import type { Agent, AgentRole } from '@/types';

const ROLES: AgentRole[] = ['pm', 'alm', 'router', 'executor'];

export function AgentStatusPanel() {
  const status = useSwarmStatus();
  const liveByRole = new Map(status.data?.agents.map((a) => [a.role, a]));

  const agents: Agent[] = ROLES.map((role) => {
    const live = liveByRole.get(role);
    return {
      id: `agent-${role}`,
      role,
      status: liveStatus(live?.lastSeen),
      lastSeen: live?.lastSeen ?? 0,
    };
  });

  const meshLabel = status.isLoading
    ? 'connecting…'
    : status.isError
      ? 'mesh unreachable'
      : agents.some((a) => a.status !== 'offline')
        ? `live · ${agents.filter((a) => a.status !== 'offline').length}/4 online`
        : 'live · all idle';

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Agent swarm</h2>
        <span className="text-[11px] text-fg-subtle uppercase tracking-wider">
          {meshLabel}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}
