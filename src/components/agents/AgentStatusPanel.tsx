import { AgentCard } from './AgentCard';
import { useSwarmStatus } from '@/hooks/useSwarmStatus';
import type { Agent, AgentRole } from '@/types';

const ROLES: AgentRole[] = ['pm', 'alm', 'router', 'executor'];

export function AgentStatusPanel() {
  const status = useSwarmStatus();

  // Build the displayed cards from live runtime rows. Fall back to
  // offline placeholders when the API hasn't responded yet so the grid
  // doesn't pop in.
  const agents: Agent[] = ROLES.map((role) => {
    const live = status.data?.agents.find((a) => a.role === role);
    return {
      id: `agent-${role}`,
      role,
      status: live?.status ?? 'offline',
      lastSeen: live?.lastSeenMs ?? 0,
    };
  });

  const onlineCount = agents.filter((a) => a.status !== 'offline').length;
  const tag =
    onlineCount === 0
      ? 'runtime · not yet connected'
      : onlineCount === ROLES.length
        ? 'runtime · all agents online'
        : `runtime · ${onlineCount} of ${ROLES.length} online`;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Agent swarm</h2>
        <span className="text-[11px] text-fg-subtle uppercase tracking-wider">
          {tag}
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
