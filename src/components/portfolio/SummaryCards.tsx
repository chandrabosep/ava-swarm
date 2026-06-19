import { useAccount } from 'wagmi';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import {
  useFungiblePositions,
  useWalletPnl,
  useWalletPortfolio,
} from '@/hooks/usePortfolio';
import { ZerionError } from '@/lib/zerion';
import { formatPct, formatUsd, formatRelative } from '@/lib/format';

export function SummaryCards() {
  const { isConnected } = useAccount();
  const portfolio = useWalletPortfolio();
  const pnl = useWalletPnl();
  // Ensure positions query is mounted so refresh hits the allocation
  // chart's data source even when only this card is visible.
  useFungiblePositions();
  const qc = useQueryClient();
  // Aggregate fetching state across all sources so the spinner reflects
  // the slowest one — refreshAll kicks off ~5 queries and the user
  // expects ↻ to stay spinning until they're all back.
  const fetchingZerion = useIsFetching({ queryKey: ['zerion'] });
  const fetchingAlchemy = useIsFetching({ queryKey: ['alchemy'] });
  const fetchingSwarm = useIsFetching({ queryKey: ['swarm-status'] });
  const anyFetching =
    portfolio.isFetching ||
    fetchingZerion > 0 ||
    fetchingAlchemy > 0 ||
    fetchingSwarm > 0;

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

  // Invalidate everything that contributes to the portfolio + allocation
  // view: portfolio totals, fungible positions (allocation chart), PnL,
  // transactions, AND the swarm-status feed that drives the agent
  // activity stream. Both providers (zerion / alchemy) are covered so
  // the refresh works the same in mainnet + testnet builds.
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['zerion'] });
    qc.invalidateQueries({ queryKey: ['alchemy'] });
    qc.invalidateQueries({ queryKey: ['swarm-status'] });
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
        <Surface className="hud-corners p-5">
          <div className="flex items-start justify-between">
            <div className="text-[10px] uppercase tracking-hud text-accent font-sans font-semibold">
              Total Value
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshAll}
              disabled={!isConnected || anyFetching}
              title="Refresh portfolio, allocation & agent activity"
            >
              {anyFetching ? '…' : '↻'}
            </Button>
          </div>
          <div className="hud-stat mt-2 text-3xl">
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

        <Surface className="hud-corners p-5">
          <div className="text-[10px] uppercase tracking-hud text-accent font-sans font-semibold">
            24h Change
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

        <Surface className="hud-corners p-5">
          <div className="text-[10px] uppercase tracking-hud text-accent font-sans font-semibold">
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
        <div className="hud-stat mt-2 text-3xl text-fg-muted">
          —
        </div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="hud-stat mt-2 text-3xl text-fg-muted">
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
      <div className="hud-stat mt-2 text-3xl">
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
        <div className="hud-stat mt-2 text-3xl text-fg-muted">
          —
        </div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="hud-stat mt-2 text-3xl text-fg-muted">
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
      <div className="hud-stat mt-2 text-3xl">
        <span className={positive ? 'text-positive' : 'text-negative'}>
          {positive ? '+' : ''}
          {formatUsd(unrealized)}
        </span>
      </div>
      <div className="mt-3 text-xs text-fg-subtle">unrealized · all-time</div>
    </>
  );
}
