import { RightRail } from '@/components/layout/RightRail';
import { SummaryCards } from '@/components/portfolio/SummaryCards';
import { AllocationChart } from '@/components/portfolio/AllocationChart';
import { AgentStatusPanel } from '@/components/agents/AgentStatusPanel';

export default function NewTab() {
  return (
    <div className="min-h-screen bg-bg text-fg flex">
      <main className="flex-1 min-w-0 px-8 py-8 space-y-8">
        <section>
          <h1 className="text-lg font-semibold tracking-tight">Portfolio</h1>
          <p className="text-sm text-fg-muted">
            Snapshot view. Live data lands when the agent runtime is wired up.
          </p>
          <div className="mt-4 space-y-4">
            <SummaryCards />
            <AllocationChart />
          </div>
        </section>

        <AgentStatusPanel />
      </main>
      <RightRail />
    </div>
  );
}
