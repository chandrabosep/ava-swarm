import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { mockPortfolio } from '@/lib/mock';
import { formatPct, formatUsd } from '@/lib/format';

export function SummaryCards() {
  const { totalValueUsd, change24hUsd, change24hPct } = mockPortfolio;
  const positive = change24hUsd >= 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Surface className="p-5">
        <div className="text-xs uppercase tracking-wider text-fg-subtle">
          Total value
        </div>
        <div className="mt-2 text-3xl font-semibold tracking-tight">
          {formatUsd(totalValueUsd)}
        </div>
        <div className="mt-3 text-xs text-fg-muted">across 3 networks · mock</div>
      </Surface>

      <Surface className="p-5">
        <div className="text-xs uppercase tracking-wider text-fg-subtle">
          24h change
        </div>
        <div className="mt-2 text-3xl font-semibold tracking-tight">
          <span className={positive ? 'text-positive' : 'text-negative'}>
            {positive ? '+' : ''}
            {formatUsd(change24hUsd)}
          </span>
        </div>
        <div className="mt-3">
          <Badge tone={positive ? 'positive' : 'negative'}>
            {formatPct(change24hPct)}
          </Badge>
        </div>
      </Surface>

      <Surface className="p-5">
        <div className="text-xs uppercase tracking-wider text-fg-subtle">
          Realized PnL · 30d
        </div>
        <div className="mt-2 text-3xl font-semibold tracking-tight text-fg-muted">
          —
        </div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting agents</div>
      </Surface>
    </div>
  );
}
