import { useAccount } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { WalletButton } from '@/components/wallet/WalletButton';
import { useWalletTransactions } from '@/hooks/usePortfolio';
import { useSwarmStatus, type IntentLogRow } from '@/hooks/useSwarmStatus';
import { describeTransaction } from '@/lib/transactions';
import { formatRelative } from '@/lib/format';
import { AgentActivityStream } from '@/components/swarm/AgentActivityStream';

export function RightRail() {
  const { isConnected } = useAccount();

  return (
    <aside className="w-80 shrink-0 border-l border-border h-screen sticky top-0 p-4 overflow-y-auto space-y-6">
      {/* Connect / account button — driven by wagmi state, never disappears.
          See WalletButton.tsx for the details. */}
      <WalletButton />
      <SwarmStatusLine />

      {/* Single activity surface — agent thoughts, decisions, and tx
          receipts in one human-readable stream. Replaces the old
          dual "Recent activity" (Zerion) + "Intents log" split. */}
      <AgentActivityStream />
    </aside>
  );
}

function SwarmStatusLine() {
  const { isConnected } = useAccount();
  const status = useSwarmStatus();
  if (!isConnected) return null;

  const activated = !!status.data?.activated;
  const onlineCount =
    status.data?.agents.filter((a) => a.status !== 'offline').length ?? 0;

  return (
    <div className="text-[11px] text-fg-subtle px-1 -mt-2">
      swarm:{' '}
      {status.isLoading && !status.data ? (
        '…'
      ) : activated ? (
        <span className="text-positive">
          active · {onlineCount} agent{onlineCount === 1 ? '' : 's'} online
        </span>
      ) : (
        <span className="text-fg-muted">not activated</span>
      )}
    </div>
  );
}

function IntentsLog() {
  const status = useSwarmStatus();
  const intents = status.data?.intents ?? [];

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Intents log</h2>
        <span className="text-[11px] text-fg-subtle">
          {intents.length === 0 ? 'empty' : `${intents.length} live`}
        </span>
      </div>
      {intents.length === 0 ? (
        <Surface className="p-4 text-xs text-fg-subtle">
          No live intents. The router will populate this stream once agents
          come online.
        </Surface>
      ) : (
        <Surface className="divide-y divide-border-subtle">
          {intents.slice(0, 10).map((intent) => (
            <IntentRow key={intent.id} intent={intent} />
          ))}
        </Surface>
      )}
    </section>
  );
}

function IntentRow({ intent }: { intent: IntentLogRow }) {
  const summary = describeIntent(intent);
  const tone =
    intent.status === 'executed'
      ? 'positive'
      : intent.status === 'failed'
        ? 'negative'
        : intent.status === 'pending'
          ? 'accent'
          : 'neutral';

  // Briefly highlight on first render so freshly-landed intents pop
  // into focus before fading into the list.
  return (
    <div className="p-3 text-sm animate-row-in">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">{summary.title}</span>
        <Badge tone={tone} dot>
          {intent.status}
        </Badge>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="truncate">{summary.subtitle}</span>
        <span className="shrink-0">
          {formatRelative(new Date(intent.createdAt).getTime())}
        </span>
      </div>
    </div>
  );
}

function describeIntent(intent: IntentLogRow): {
  title: string;
  subtitle: string;
} {
  const payload = (intent.payload ?? {}) as Record<string, unknown>;
  const kind = (payload.kind as string | undefined) ?? intent.fromAgent;
  if (kind === 'allocation') {
    const targets =
      (payload.targets as Array<{ symbol: string; weight: number }> | undefined) ??
      [];
    const summary = targets
      .map((t) => `${t.symbol} ${(t.weight * 100).toFixed(0)}%`)
      .join(' · ');
    return { title: 'Allocation', subtitle: summary || 'no targets' };
  }
  if (kind === 'routed') {
    const tokenIn = (payload.tokenIn as string | undefined) ?? '?';
    const tokenOut = (payload.tokenOut as string | undefined) ?? '?';
    const notional = payload.notionalUsd as number | undefined;
    return {
      title: `Route ${shortToken(tokenIn)} → ${shortToken(tokenOut)}`,
      subtitle:
        typeof notional === 'number'
          ? `$${notional.toFixed(2)} · ${intent.fromAgent}`
          : intent.fromAgent,
    };
  }
  return {
    title: `${intent.fromAgent} intent`,
    subtitle: kind ?? '—',
  };
}

function shortToken(token: string): string {
  if (token.length <= 6) return token;
  return `${token.slice(0, 6)}…`;
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
