import { useAccount } from 'wagmi';
import { Surface } from '@/components/common/Surface';
import { useFungiblePositions } from '@/hooks/usePortfolio';
import { summarizePositions } from '@/lib/portfolio';
import { formatPct, formatUsd } from '@/lib/format';
import { USE_TESTNET } from '@/config/swarm';

const SLICE_COLORS = [
  'bg-accent',
  'bg-positive',
  'bg-warning',
  'bg-negative',
  'bg-fg-muted',
];

export function AllocationChart() {
  const { isConnected } = useAccount();
  const positions = useFungiblePositions();

  const summary = positions.data
    ? summarizePositions(positions.data.data)
    : null;
  const allocations = summary?.allocations ?? [];

  return (
    <Surface className="hud-corners p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="hud-title text-sm">Allocation</h3>
        <span className="text-[10px] text-fg-subtle uppercase tracking-hud font-sans">
          {!isConnected
            ? 'connect wallet'
            : positions.isLoading
              ? 'loading'
              : positions.error
                ? 'error'
                : USE_TESTNET
                  ? 'live · alchemy'
                  : 'live · zerion'}
        </span>
      </div>

      {/* Stacked bar — keeps us off a chart library for now. */}
      <div
        className="mt-4 h-2.5 w-full rounded-sm overflow-hidden flex bg-bg-hover/60 border border-border-subtle shadow-[inset_0_0_8px_rgba(0,0,0,0.5)]"
        role="img"
        aria-label="Portfolio allocation by token"
      >
        {allocations.length === 0 ? (
          <div className="w-full bg-bg-hover" />
        ) : (
          allocations.map((slice, i) => (
            <div
              key={`${slice.symbol}-${i}`}
              className={SLICE_COLORS[i % SLICE_COLORS.length]}
              style={{ width: `${slice.pct * 100}%` }}
              title={`${slice.symbol}: ${formatPct(slice.pct)}`}
            />
          ))
        )}
      </div>

      {allocations.length === 0 ? (
        <div className="mt-4 text-sm text-fg-subtle space-y-1">
          <p>
            {!isConnected
              ? 'Connect a wallet to see your token allocation.'
              : positions.isLoading
                ? `Fetching positions from ${USE_TESTNET ? 'Alchemy' : 'Zerion'}…`
                : positions.error
                  ? 'Could not load positions.'
                  : 'No positions found for this address.'}
          </p>
          {positions.error ? (
            <p className="text-[11px] text-negative font-mono break-all">
              {positions.error instanceof Error
                ? positions.error.message
                : String(positions.error)}
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {allocations.map((slice, i) => (
            <li
              key={`${slice.symbol}-${i}`}
              className="flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 rounded-sm ${SLICE_COLORS[i % SLICE_COLORS.length]}`}
                />
                <span className="font-medium">{slice.symbol}</span>
                <span className="text-fg-muted text-xs">
                  {formatPct(slice.pct)}
                </span>
              </span>
              <span className="text-fg-muted tabular-nums">
                {formatUsd(slice.valueUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
