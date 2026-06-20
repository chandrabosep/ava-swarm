// "Agents that hire agents" panel — the Speedrun: Agentic Payments centerpiece.
//
// Left: the specialist roster, each an ERC-8004-registered agent with a live
// reputation score and its x402 price. Right: the live payment feed — every
// time PM hires a specialist, a row lands with the USDC amount and a Snowtrace
// link to the on-chain settlement (and the reputation-feedback tx).

import { Surface } from '@/components/common/Surface';
import { useMarketplace, type MarketplaceHire } from '@/hooks/useMarketplace';
import { addressUrl, txUrl, defaultExplorerChain } from '@/lib/explorer';

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function repTone(score: number): string {
  if (score >= 75) return 'text-positive';
  if (score >= 50) return 'text-accent';
  return 'text-warning';
}

export function AgentMarketplacePanel() {
  const { data } = useMarketplace();
  const specialists = data?.specialists ?? [];
  const hires = data?.hires ?? [];
  const registriesLive = !!data?.reputationRegistry;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="hud-title text-sm">Agent Marketplace · x402 + ERC-8004</h2>
        <span className="text-[10px] text-fg-subtle uppercase tracking-hud font-sans">
          {data ? `${data.network} · ${registriesLive ? 'reputation live' : 'reputation pending'}` : 'connecting…'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Roster — sellers ranked by ERC-8004 reputation. */}
        <Surface className="p-4">
          <h3 className="text-[11px] uppercase tracking-hud text-fg-subtle font-sans mb-3">
            Specialists for hire
          </h3>
          <div className="space-y-3">
            {specialists.length === 0 && (
              <p className="text-[11px] text-fg-subtle font-sans">
                Waiting for the agents API…
              </p>
            )}
            {[...specialists]
              .sort((a, b) => b.reputation.avgScore - a.reputation.avgScore)
              .map((s) => (
                <div
                  key={s.role}
                  className="flex items-center justify-between gap-3 border-b border-accent/10 pb-2 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-fg font-display">{s.label}</span>
                      {s.agentId !== null && (
                        <span className="text-[10px] font-mono text-fg-subtle">
                          #{s.agentId}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-fg-subtle font-sans truncate">
                      {s.description}
                    </div>
                    {s.payTo && (
                      <a
                        href={addressUrl(s.payTo, defaultExplorerChain)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] font-mono text-accent/80 hover:text-accent"
                      >
                        {short(s.payTo)}
                      </a>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-base font-mono ${repTone(s.reputation.avgScore)}`}>
                      {s.reputation.avgScore}
                    </div>
                    <div className="text-[10px] text-fg-subtle font-sans">
                      {s.reputation.count} reviews
                    </div>
                    <div className="text-[11px] font-mono text-fg-muted">{s.price}</div>
                  </div>
                </div>
              ))}
          </div>
        </Surface>

        {/* Live payment feed. */}
        <Surface className="p-4">
          <h3 className="text-[11px] uppercase tracking-hud text-fg-subtle font-sans mb-3">
            Live x402 payments
          </h3>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {hires.length === 0 && (
              <p className="text-[11px] text-fg-subtle font-sans">
                No hires yet — PM commissions specialists every ~45s once funded.
              </p>
            )}
            {hires.map((h, i) => (
              <HireRow key={`${h.payTxHash ?? 'pending'}-${i}`} h={h} />
            ))}
          </div>
        </Surface>
      </div>
    </section>
  );
}

function HireRow({ h }: { h: MarketplaceHire }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px] font-sans border-b border-accent/10 pb-1.5 last:border-0">
      <div className="min-w-0">
        <span className="text-fg">{h.label ?? h.specialist}</span>
        {h.score !== null && (
          <span className="ml-2 font-mono text-fg-subtle">→ rated {h.score}</span>
        )}
        {!h.ok && <span className="ml-2 text-warning">failed{h.error ? `: ${h.error}` : ''}</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0 font-mono">
        {h.price && <span className="text-positive">{h.price}</span>}
        {h.payTxHash && (
          <a
            href={txUrl(h.payTxHash, defaultExplorerChain)}
            target="_blank"
            rel="noreferrer"
            className="text-accent/80 hover:text-accent"
            title="x402 settlement"
          >
            pay↗
          </a>
        )}
        {h.feedbackTx && (
          <a
            href={txUrl(h.feedbackTx, defaultExplorerChain)}
            target="_blank"
            rel="noreferrer"
            className="text-accent/60 hover:text-accent"
            title="ERC-8004 feedback"
          >
            rep↗
          </a>
        )}
      </div>
    </div>
  );
}
