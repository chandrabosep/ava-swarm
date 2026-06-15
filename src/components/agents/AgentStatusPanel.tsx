import { AgentCard } from './AgentCard';
import { mockAgents } from '@/lib/mock';

export function AgentStatusPanel() {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Agent swarm</h2>
        <span className="text-[11px] text-fg-subtle uppercase tracking-wider">
          shell · runtime not yet connected
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {mockAgents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}
