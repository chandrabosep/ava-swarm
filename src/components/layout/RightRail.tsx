import { useAccount } from 'wagmi';
import { WalletButton } from '@/components/wallet/WalletButton';
import { useSwarmStatus } from '@/hooks/useSwarmStatus';
import { AgentActivityStream } from '@/components/swarm/AgentActivityStream';

export function RightRail() {
  return (
    <aside className="w-[420px] shrink-0 border-l border-accent/20 h-full p-5 overflow-y-auto space-y-6 bg-bg/40 backdrop-blur-sm">
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
