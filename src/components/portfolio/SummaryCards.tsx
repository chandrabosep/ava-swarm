import { useAccount } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import {
  useWalletPnl,
  useWalletPortfolio,
} from '@/hooks/usePortfolio';
import { ZerionError } from '@/lib/zerion';
import { formatPct, formatUsd, formatRelative } from '@/lib/format';

export function SummaryCards() {
  const { isConnected } = useAccount();
  const portfolio = useWalletPortfolio();
  const pnl = useWalletPnl();
  const qc = useQueryClient();

  const attrs = portfolio.data?.data.attributes;
  const totalValueUsd = attrs?.total.positions ?? 0;
  const change24hPct = attrs?.changes.percent_1d ?? 0;
  const change24hUsd = attrs?.changes.absolute_1d ?? 0;
  const chainCount = attrs
    ? Object.values(attrs.positions_distribution_by_chain).filter(
        (v) => v > 0,
      ).length
    : 0;

  const isRateLimited =
    (portfolio.error instanceof ZerionError && portfolio.error.status === 429) ||
    (pnl.error instanceof ZerionError && pnl.error.status === 429);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['zerion'] });
  };

  return (
    <div className="space-y-3">
      {isRateLimited && (
        <div className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-md px-3 py-2">
          Zerion rate limit hit. Demo plan = 300 req/day. Cached values
          still display below; new fetches will resume after the limit resets.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Surface className="p-5">
          <div className="flex items-start justify-between">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">
              Total value
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshAll}
              disabled={!isConnected || portfolio.isFetching}
              title="Refresh portfolio"
            >
              {portfolio.isFetching ? '…' : '↻'}
            </Button>
          </div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {!isConnected ? (
              <span className="text-fg-muted">—</span>
            ) : portfolio.isLoading ? (
              <span className="text-fg-muted">…</span>
            ) : portfolio.error && !attrs ? (
              <span className="text-negative text-base">unavailable</span>
            ) : (
              formatUsd(totalValueUsd)
            )}
          </div>
          <div className="mt-3 text-xs text-fg-muted">
            {!isConnected
              ? 'Connect a wallet to see your portfolio'
              : portfolio.isLoading
                ? 'fetching from Zerion…'
                : portfolio.dataUpdatedAt
                  ? `across ${chainCount || '—'} ${chainCount === 1 ? 'network' : 'networks'} · updated ${formatRelative(portfolio.dataUpdatedAt)}`
                  : `across ${chainCount || '—'} networks`}
          </div>
        </Surface>

        <Surface className="p-5">
          <div className="text-xs uppercase tracking-wider text-fg-subtle">
            24h change
          </div>
          <ChangeValue
            isConnected={isConnected}
            isLoading={portfolio.isLoading}
            hasError={!!portfolio.error && !attrs}
            changeUsd={change24hUsd}
            changePct={change24hPct / 100}
            hasData={!!attrs}
          />
        </Surface>

        <Surface className="p-5">
          <div className="text-xs uppercase tracking-wider text-fg-subtle">
            Unrealized PnL
          </div>
          <PnlValue
            isConnected={isConnected}
            isLoading={pnl.isLoading}
            hasError={!!pnl.error && !pnl.data}
            unrealized={pnl.data?.data.attributes.unrealized_gain ?? null}
          />
        </Surface>
      </div>
    </div>
  );
}

interface ChangeProps {
  isConnected: boolean;
  isLoading: boolean;
  hasError: boolean;
  changeUsd: number;
  changePct: number;
  hasData: boolean;
}

function ChangeValue({
  isConnected,
  isLoading,
  hasError,
  changeUsd,
  changePct,
  hasData,
}: ChangeProps) {
  if (!isConnected) {
    return (
      <>
        <div className="mt-2 text-3xl font-semibold tracking-tight text-fg-muted">
          —
        </div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="mt-2 text-3xl font-semibold tracking-tight text-fg-muted">
        …
      </div>
    );
  }
  if (hasError || !hasData) {
    return <div className="mt-2 text-base text-negative">unavailable</div>;
  }
  const positive = changeUsd >= 0;
  return (
    <>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        <span className={positive ? 'text-positive' : 'text-negative'}>
          {positive ? '+' : ''}
          {formatUsd(changeUsd)}
        </span>
      </div>
      <div className="mt-3">
        <Badge tone={positive ? 'positive' : 'negative'}>
          {formatPct(changePct)}
        </Badge>
      </div>
    </>
  );
}

interface PnlProps {
  isConnected: boolean;
  isLoading: boolean;
  hasError: boolean;
  unrealized: number | null;
}

function PnlValue({ isConnected, isLoading, hasError, unrealized }: PnlProps) {
  if (!isConnected) {
    return (
      <>
        <div className="mt-2 text-3xl font-semibold tracking-tight text-fg-muted">
          —
        </div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="mt-2 text-3xl font-semibold tracking-tight text-fg-muted">
        …
      </div>
    );
  }
  if (hasError || unrealized === null) {
    return <div className="mt-2 text-base text-negative">unavailable</div>;
  }
  const positive = unrealized >= 0;
  return (
    <>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        <span className={positive ? 'text-positive' : 'text-negative'}>
          {positive ? '+' : ''}
          {formatUsd(unrealized)}
        </span>
      </div>
      <div className="mt-3 text-xs text-fg-subtle">unrealized · all-time</div>
    </>
  );
}
