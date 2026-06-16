import { useAccount } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { WalletButton } from '@/components/wallet/WalletButton';
import { useWalletTransactions } from '@/hooks/usePortfolio';
import { describeTransaction } from '@/lib/transactions';
import { formatRelative } from '@/lib/format';

export function RightRail() {
  const { isConnected } = useAccount();
  const txs = useWalletTransactions({ pageSize: 8 });
  const qc = useQueryClient();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['zerion', 'transactions'] });
  };

  return (
    <aside className="w-80 shrink-0 border-l border-border h-screen sticky top-0 p-4 overflow-y-auto space-y-6">
      {/* Connect / account button — driven by wagmi state, never disappears.
          See WalletButton.tsx for the details. */}
      <WalletButton />

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={refresh}
            disabled={!isConnected || txs.isFetching}
            title="Refresh transactions"
          >
            {txs.isFetching ? '…' : '↻'}
          </Button>
        </div>
        <RecentActivity
          isConnected={isConnected}
          isLoading={txs.isLoading}
          error={txs.error}
          data={txs.data?.data}
        />
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Intents log</h2>
          <span className="text-[11px] text-fg-subtle">empty</span>
        </div>
        <Surface className="p-4 text-xs text-fg-subtle">
          No live intents. The router will populate this stream once agents
          come online.
        </Surface>
      </section>
    </aside>
  );
}

interface RecentActivityProps {
  isConnected: boolean;
  isLoading: boolean;
  error: unknown;
  data: import('@/types/zerion').ZerionTransaction[] | undefined;
}

function RecentActivity({
  isConnected,
  isLoading,
  error,
  data,
}: RecentActivityProps) {
  if (!isConnected) {
    return (
      <Surface className="p-4 text-xs text-fg-subtle">
        Connect a wallet to see recent activity.
      </Surface>
    );
  }
  if (isLoading) {
    return (
      <Surface className="p-4 text-xs text-fg-subtle">
        Fetching from Zerion…
      </Surface>
    );
  }
  if (error) {
    return (
      <Surface className="p-4 text-xs text-fg-subtle space-y-1">
        <p>Could not load transactions.</p>
        <p className="text-[11px] text-negative font-mono break-all">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </Surface>
    );
  }
  if (!data || data.length === 0) {
    return (
      <Surface className="p-4 text-xs text-fg-subtle">
        No transactions in the last few weeks.
      </Surface>
    );
  }

  return (
    <Surface className="divide-y divide-border-subtle">
      {data.map((tx) => {
        const d = describeTransaction(tx);
        return (
          <div key={tx.id} className="p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{d.title}</span>
              <Badge tone={d.tone} dot>
                {d.statusLabel}
              </Badge>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-fg-muted">
              <span className="truncate">{d.subtitle}</span>
              <span className="shrink-0">
                {d.timestamp ? formatRelative(d.timestamp) : 'pending'}
              </span>
            </div>
          </div>
        );
      })}
    </Surface>
  );
}
