import { Surface } from '@/components/common/Surface';
import { mockPortfolio } from '@/lib/mock';
import { formatPct, formatUsd } from '@/lib/format';

const SLICE_COLORS = [
  'bg-accent',
  'bg-positive',
  'bg-warning',
  'bg-negative',
  'bg-fg-muted',
];

export function AllocationChart() {
  const { allocations } = mockPortfolio;

  return (
    <Surface className="p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Allocation</h3>
        <span className="text-[11px] text-fg-subtle uppercase tracking-wider">
          mock · placeholder
        </span>
      </div>

      {/* Stacked bar — keeps us off a chart library for the shell phase. */}
      <div
        className="mt-4 h-2.5 w-full rounded-full overflow-hidden flex bg-bg-hover"
        role="img"
        aria-label="Portfolio allocation by token"
      >
        {allocations.map((slice, i) => (
          <div
            key={slice.symbol}
            className={SLICE_COLORS[i % SLICE_COLORS.length]}
            style={{ width: `${slice.pct * 100}%` }}
            title={`${slice.symbol}: ${formatPct(slice.pct)}`}
          />
        ))}
      </div>

      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {allocations.map((slice, i) => (
          <li
            key={slice.symbol}
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
    </Surface>
  );
}
