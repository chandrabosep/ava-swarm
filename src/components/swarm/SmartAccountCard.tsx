import { useState } from 'react';
import { useAccount } from 'wagmi';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useSwarmStatus } from '@/hooks/useSwarmStatus';
import { DelegateSwarmDialog } from './DelegateSwarmDialog';
import { shortAddress } from '@/lib/format';

/**
 * Top-of-dashboard tile that shows delegation status.
 *
 * Architecture: EIP-7702 + agent-key delegation. The user's EOA *is*
 * the smart account — funds never move. A single EIP-712 signature
 * authorizes the four agent service addresses to act within a scoped
 * (target, selector) whitelist for 30 days.
 *
 * States rendered:
 *   - wallet not connected → muted, no CTA
 *   - connected, not delegated → "Delegate Swarm" CTA + brief explainer
 *   - delegated → EOA address, agents online count, expiry, revoke CTA
 */
export function SmartAccountCard() {
  const { isConnected, address: owner } = useAccount();
  const status = useSwarmStatus();
  const [delegating, setDelegating] = useState(false);

  if (!isConnected || !owner) {
    return (
      <Surface className="p-5">
        <Header subtitle="Connect a wallet above to set up your swarm." />
      </Surface>
    );
  }

  const activated = !!status.data?.activated;
  const onlineCount =
    status.data?.agents.filter((a) => a.status !== 'offline').length ?? 0;

  if (!activated) {
    return (
      <>
        <Surface className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Header subtitle="One signature delegates scoped authority to the four agents. Funds stay in your EOA — no Safe deploy, no funding, no migration. Powered by EIP-7702." />
              <div className="mt-3 text-xs text-fg-subtle">
                Account address:{' '}
                <span className="font-mono text-fg-muted">
                  {shortAddress(owner)}
                </span>{' '}
                · your EOA is the account
              </div>
            </div>
            <Button
              variant="primary"
              onClick={() => setDelegating(true)}
              disabled={!owner}
            >
              Delegate Swarm
            </Button>
          </div>
        </Surface>
        {delegating && (
          <DelegateSwarmDialog onClose={() => setDelegating(false)} />
        )}
      </>
    );
  }

  const validUntil = status.data?.sessions[0]?.validUntil;
  const expiresIn = validUntil ? humanExpiry(validUntil) : '—';

  return (
    <Surface className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold tracking-tight">
              Smart account
            </h2>
            <Badge tone="positive" dot>
              delegated
            </Badge>
          </div>
          <div className="mt-2 font-mono text-fg text-base">
            {shortAddress(owner)}
          </div>
          <div className="mt-1 text-xs text-fg-subtle">
            EOA-as-account · {onlineCount} of 4 agents online · expires {expiresIn}
          </div>
        </div>
        <div className="text-right text-xs text-fg-muted">
          <div>EIP-7702 / Calibur-style</div>
          <div className="text-fg-subtle">delegation valid for 30d</div>
        </div>
      </div>
    </Surface>
  );
}

function Header({ subtitle }: { subtitle: string }) {
  return (
    <>
      <h2 className="text-sm font-semibold tracking-tight">Smart account</h2>
      <p className="mt-1 text-xs text-fg-muted leading-relaxed max-w-xl">
        {subtitle}
      </p>
    </>
  );
}

function humanExpiry(validUntil: string): string {
  const ms = new Date(validUntil).getTime() - Date.now();
  if (ms < 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `in ${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return `in ${hours}h`;
}
