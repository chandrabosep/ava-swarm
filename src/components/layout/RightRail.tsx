import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { WalletButton } from '@/components/wallet/WalletButton';
import { mockIntents, ROLE_LABELS } from '@/lib/mock';
import { formatRelative } from '@/lib/format';
import type { IntentStatus } from '@/types';

const STATUS_TONE: Record<
  IntentStatus,
  'neutral' | 'positive' | 'warning' | 'accent'
> = {
  pending: 'warning',
  netted: 'accent',
  routed: 'accent',
  executed: 'positive',
};

export function RightRail() {
  return (
    <aside className="w-80 shrink-0 border-l border-border h-screen sticky top-0 p-4 overflow-y-auto space-y-6">
      {/* Custom connect/account button driven by wagmi state — see
          WalletButton.tsx for why we don't use <appkit-button /> directly. */}
      <WalletButton />

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <span className="text-[11px] text-fg-subtle">mock data</span>
        </div>
        <Surface className="divide-y divide-border-subtle">
          {mockIntents.map((intent) => (
            <div key={intent.id} className="p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {intent.tokenIn} → {intent.tokenOut}
                </span>
                <Badge tone={STATUS_TONE[intent.status]} dot>
                  {intent.status}
                </Badge>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
                <span>
                  {ROLE_LABELS[intent.from]} · {intent.amount} {intent.tokenIn}
                </span>
                <span>{formatRelative(intent.createdAt)}</span>
              </div>
            </div>
          ))}
        </Surface>
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
