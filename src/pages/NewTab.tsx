import { RightRail } from '@/components/layout/RightRail';
import { SummaryCards } from '@/components/portfolio/SummaryCards';
import { AllocationChart } from '@/components/portfolio/AllocationChart';
import { AgentStatusPanel } from '@/components/agents/AgentStatusPanel';
import { SmartAccountCard } from '@/components/swarm/SmartAccountCard';
import { RiskProfileCard } from '@/components/swarm/RiskProfileCard';
import { SkillConnectorCard } from '@/components/swarm/SkillConnectorCard';

export default function NewTab() {
  return (
    // App shell: locks the document to viewport height so the page itself
    // never scrolls. The two children that need to scroll (main column +
    // right rail) each own their own overflow. This prevents the
    // double-scrollbar effect where the rail and the document fought
    // each other.
    <div className="h-screen text-fg flex flex-col relative overflow-hidden">
      {/* Page-wide CRT scanline overlay — fixed, non-interactive. */}
      <div className="hud-scanline" />

      {/* HUD command bar */}
      <CommandBar />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <main className="flex-1 min-w-0 px-8 py-6 space-y-8 overflow-y-auto">
          <section>
            <SectionHeader
              title="Portfolio"
              subtitle="Snapshot view · live data lands when the agent runtime is wired up."
            />
            <div className="mt-4 space-y-4">
              <SummaryCards />
              <AllocationChart />
            </div>
          </section>

          <SmartAccountCard />
          <RiskProfileCard />
          <SkillConnectorCard />
          <AgentStatusPanel />
        </main>
        <RightRail />
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="space-y-1">
      <h1 className="hud-title text-sm">{title}</h1>
      <p className="text-[11px] uppercase tracking-hud text-fg-subtle font-sans">
        {subtitle}
      </p>
    </div>
  );
}

function CommandBar() {
  return (
    <header
      className="relative z-10 flex items-center justify-between gap-4 px-8 py-3
        border-b border-accent/20 bg-bg/60 backdrop-blur-md"
    >
      <div className="flex items-center gap-4">
        {/* Cube glyph — pure CSS chevron stack. */}
        <div className="relative size-9 grid place-items-center">
          <span
            aria-hidden
            className="absolute inset-0 rounded-sm border border-accent/60
              shadow-[0_0_12px_-2px_rgba(0,229,255,0.6)]"
            style={{
              clipPath:
                'polygon(20% 0, 100% 0, 100% 80%, 80% 100%, 0 100%, 0 20%)',
            }}
          />
          <span className="font-display font-bold text-accent text-sm">
            DS
          </span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="hud-logo text-base animate-flicker">
            DeFi · Swarm
          </span>
          <span className="text-[10px] tracking-hud uppercase text-fg-subtle font-sans">
            Autonomous Treasury HUD · v0.1
          </span>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-6 text-[10px] uppercase tracking-hud font-sans text-fg-subtle">
        <StatusPip label="Link" tone="ok" value="online" />
        <StatusPip label="Net" tone="ok" value="mainnet" />
        <StatusPip label="Sec" tone="ok" value="EIP-7702" />
      </div>
    </header>
  );
}

function StatusPip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn';
}) {
  const dot =
    tone === 'ok'
      ? 'bg-positive shadow-[0_0_6px_rgba(57,255,159,0.7)]'
      : 'bg-warning shadow-[0_0_6px_rgba(255,181,71,0.7)]';
  return (
    <div className="flex items-center gap-2">
      <span className={`size-1.5 rounded-full animate-blink ${dot}`} />
      <span className="text-fg-subtle">{label}</span>
      <span className="text-fg-muted font-mono normal-case tracking-normal text-[11px]">
        {value}
      </span>
    </div>
  );
}

