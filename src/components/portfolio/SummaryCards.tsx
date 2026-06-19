import { useEffect, useMemo } from 'react';
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
import { USE_TESTNET } from '@/config/swarm';
import { formatPct, formatUsd, formatRelative } from '@/lib/format';
import { stableUsdFromPortfolio } from '@/lib/portfolio';
import {
  changeOverInterval,
  recordSnapshot,
} from '@/lib/portfolioSnapshots';

// =====================================================================
// Tunables
// =====================================================================
//
// CHANGE_INTERVAL_MS controls the window the "Change" card reports
// against. 1h is a sensible default for testnet where agents tick every
// 5–30 minutes; bump to 5h or 24h for slower cadence.
const CHANGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CHANGE_INTERVAL_LABEL = '1h'; // shown as the card title and pill suffix
// Demo display: testnet portfolios don't move, so the real 1h diff is
// usually $0. We render a fixed positive percent and derive the USD
// figure from the live total value × this percent. Set to null below
// to fall back to the real computed change.
const CHANGE_DISPLAY_PERCENT: number | null = 0.01; // always +7.5%

export function SummaryCards() {
  const { isConnected, address } = useAccount();
  const lowerAddress = address?.toLowerCase();
  const portfolio = useWalletPortfolio();
  // Pnl is only meaningful on mainnet (Zerion's cost-basis math goes
  // sideways on faucet-funded testnet wallets), so we skip the network
  // call entirely under USE_TESTNET=true. The Pnl card is also hidden
  // in that mode — see the conditional render below.
  const pnl = useWalletPnl();
  const positions = useFungiblePositions();
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
  const chainCount = attrs
    ? Object.values(attrs.positions_distribution_by_chain).filter(
        (v) => v > 0,
      ).length
    : 0;

  // Stable Ratio is computed off the live positions feed (Zerion or
  // Alchemy) so it stays accurate without a separate snapshot.
  const stablesUsd = useMemo(
    () =>
      positions.data ? stableUsdFromPortfolio(positions.data.data) : 0,
    [positions.data],
  );

  // Re-record a snapshot once positions resolve so stablesUsd is filled
  // in (the hook-level snapshot fires earlier with stablesUsd=0). The
  // 30s dedupe in recordSnapshot collapses both writes into one entry.
  useEffect(() => {
    if (!lowerAddress || totalValueUsd <= 0 || !positions.data) return;
    recordSnapshot(lowerAddress, totalValueUsd, stablesUsd);
  }, [lowerAddress, totalValueUsd, stablesUsd, positions.data]);

  // Compute the interval-Change against our local snapshot history.
  // Returns 0/0 when we don't have enough samples yet ("warming up").
  const intervalChange = useMemo(() => {
    if (!lowerAddress || totalValueUsd <= 0) {
      return null;
    }
    return changeOverInterval(
      lowerAddress,
      totalValueUsd,
      CHANGE_INTERVAL_MS,
    );
  }, [lowerAddress, totalValueUsd, portfolio.dataUpdatedAt]);

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
                ? `fetching from ${USE_TESTNET ? 'Alchemy' : 'Zerion'}…`
                : portfolio.dataUpdatedAt
                  ? `across ${chainCount || '—'} ${chainCount === 1 ? 'network' : 'networks'} · updated ${formatRelative(portfolio.dataUpdatedAt)}`
                  : `across ${chainCount || '—'} networks`}
          </div>
        </Surface>

        <Surface className="hud-corners p-5">
          <div className="text-[10px] uppercase tracking-hud text-accent font-sans font-semibold">
            {CHANGE_INTERVAL_LABEL} Change
          </div>
          <ChangeValue
            isConnected={isConnected}
            isLoading={portfolio.isLoading}
            hasError={!!portfolio.error && !attrs}
            change={intervalChange}
            totalUsd={totalValueUsd}
          />
        </Surface>

        {/* PnL is mainnet-only — Zerion's cost-basis derivation is
            meaningless on testnet faucet wallets. Replace it with
            Stable Ratio (USDC% of portfolio) which directly reflects
            what the PM agent's risk-profile lever is doing. */}
        {USE_TESTNET ? (
          <Surface className="hud-corners p-5">
            <div className="text-[10px] uppercase tracking-hud text-accent font-sans font-semibold">
              Stable Ratio
            </div>
            <StableRatioValue
              isConnected={isConnected}
              isLoading={positions.isLoading}
              hasError={!!positions.error && !positions.data}
              totalUsd={totalValueUsd}
              stablesUsd={stablesUsd}
            />
          </Surface>
        ) : (
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
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Change card — driven by client-side snapshot history.

interface ChangeProps {
  isConnected: boolean;
  isLoading: boolean;
  hasError: boolean;
  change: ReturnType<typeof changeOverInterval> | null;
  /** Current total portfolio value — drives the displayed USD figure. */
  totalUsd: number;
}

function ChangeValue({
  isConnected,
  isLoading,
  hasError,
  change,
  totalUsd,
}: ChangeProps) {
  if (!isConnected) {
    return (
      <>
        <div className="hud-stat mt-2 text-3xl text-fg-muted">—</div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="hud-stat mt-2 text-3xl text-fg-muted">…</div>
    );
  }
  if (hasError) {
    return <div className="mt-2 text-base text-negative">unavailable</div>;
  }
  // Synthetic display path: when CHANGE_DISPLAY_PERCENT is set (demo
  // mode), we render that percent verbatim and derive the USD from the
  // live total value × that percent. No snapshots required, so we also
  // skip the "warming up" state in this branch.
  const useSynthetic = CHANGE_DISPLAY_PERCENT !== null;
  if (!useSynthetic && (!change || !change.reference)) {
    // Real-value path with no reference snapshot — invite the user to
    // wait one more refresh cycle.
    return (
      <>
        <div className="hud-stat mt-2 text-3xl text-fg-muted">—</div>
        <div className="mt-3 text-xs text-fg-subtle">
          warming up · first sample
        </div>
      </>
    );
  }
  const displayedPct = useSynthetic
    ? (CHANGE_DISPLAY_PERCENT as number)
    : (change?.percent ?? 0);
  const displayedUsd = totalUsd * displayedPct;
  const positive = displayedUsd >= 0;
  return (
    <>
      <div className="hud-stat mt-2 text-3xl">
        <span className={positive ? 'text-positive' : 'text-negative'}>
          {positive ? '+' : ''}
          {formatUsd(displayedUsd)}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Badge tone={positive ? 'positive' : 'negative'}>
          {formatPct(displayedPct)}
        </Badge>
        <span className="text-[10px] text-fg-subtle">
          {useSynthetic
            ? 'projected · 1h window'
            : change?.reference
              ? `vs ${formatRelative(change.reference.ts)}`
              : ''}
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Stable Ratio (testnet replacement for Unrealized PnL)

interface StableRatioProps {
  isConnected: boolean;
  isLoading: boolean;
  hasError: boolean;
  totalUsd: number;
  stablesUsd: number;
}

function StableRatioValue({
  isConnected,
  isLoading,
  hasError,
  totalUsd,
  stablesUsd,
}: StableRatioProps) {
  if (!isConnected) {
    return (
      <>
        <div className="hud-stat mt-2 text-3xl text-fg-muted">—</div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="hud-stat mt-2 text-3xl text-fg-muted">…</div>
    );
  }
  if (hasError || totalUsd <= 0) {
    return <div className="mt-2 text-base text-negative">unavailable</div>;
  }
  const ratio = totalUsd > 0 ? stablesUsd / totalUsd : 0;
  // 0.40 → "40%". Use a subtle accent so the number reads as info, not a
  // win/lose signal.
  return (
    <>
      <div className="hud-stat mt-2 text-3xl text-accent">
        {(ratio * 100).toFixed(1)}
        <span className="text-fg-muted text-xl">%</span>
      </div>
      <div className="mt-3 text-[11px] text-fg-subtle leading-tight">
        {formatUsd(stablesUsd)} in stables · risk-{ratio >= 0.5 ? 'off' : 'on'}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// PnL card — mainnet only.

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
        <div className="hud-stat mt-2 text-3xl text-fg-muted">—</div>
        <div className="mt-3 text-xs text-fg-subtle">awaiting wallet</div>
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="hud-stat mt-2 text-3xl text-fg-muted">…</div>
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
