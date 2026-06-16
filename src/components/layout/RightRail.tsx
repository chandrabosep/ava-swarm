import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
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
      {/* Wallet — chain selector + connect button. Sits at the top so it's
          always reachable; the rest of the rail is read-only context. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Wallet</h2>
        </div>
        <Surface variant="raised" className="p-3 flex flex-col gap-2">
          <appkit-network-button />
          <appkit-button balance="hide" size="md" />
        </Surface>
      </section>

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
