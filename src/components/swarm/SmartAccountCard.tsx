import { useState } from 'react';
import { formatEther } from 'viem';
import { useAccount } from 'wagmi';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useSafe, useSessions } from '@/hooks/useSafe';
import { useSafeAllChains } from '@/hooks/useSafeAllChains';
import { ActivateSwarmDialog } from './ActivateSwarmDialog';
import { AddOwnerDialog } from './AddOwnerDialog';
import { CrossChainExpansion } from './CrossChainExpansion';
import { shortAddress } from '@/lib/format';
import { SUPPORTED_CHAINS } from '@/types/swarm';

/**
 * Top-of-dashboard tile that shows smart-account status.
 *
 * States rendered:
 *   - wallet not connected   → muted, no CTA
 *   - connected, no Safe yet → "Activate Swarm" CTA + brief explainer
 *   - Safe deployed, sessions granted → address, balance, owners,
 *     cross-chain expansion, "Add owner" button
 */
export function SmartAccountCard() {
  const { isConnected, address: owner } = useAccount();
  const safe = useSafe();
  const sessions = useSessions();
  const allChains = useSafeAllChains();
  const [activating, setActivating] = useState(false);
  const [addingOwner, setAddingOwner] = useState(false);

  if (!isConnected) {
    return (
      <Surface className="p-5">
        <Header subtitle="Connect a wallet above to set up your swarm." />
      </Surface>
    );
  }

  const data = safe.data;
  const deployed = !!data?.deployment.deployed;
  const moduleOn = !!data?.deployment.smartSessionsInstalled;
  const hasSessions = !!sessions.data?.alm && !!sessions.data?.executor;

  // First-time activation
  if (!deployed || !moduleOn || !hasSessions) {
    return (
      <>
        <Surface className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Header subtitle="Deploy a Safe smart account, grant scoped permissions to ALM and Executor, and your swarm is ready." />
              {data && (
                <div className="mt-3 text-xs text-fg-subtle">
                  Predicted address:{' '}
                  <span className="font-mono text-fg-muted">
                    {shortAddress(data.safeAddress)}
                  </span>{' '}
                  · same on every supported chain
                </div>
              )}
            </div>
            <Button
              variant="primary"
              onClick={() => setActivating(true)}
              disabled={!owner || safe.isLoading}
            >
              Activate Swarm
            </Button>
          </div>
        </Surface>
        {activating && (
          <ActivateSwarmDialog onClose={() => setActivating(false)} />
        )}
      </>
    );
  }

  // Active state — show address, balance, sessions, cross-chain, add-owner.
  const allChainsData = allChains.data;
  const activeChainCount = allChainsData
    ? SUPPORTED_CHAINS.filter(
        (c) =>
          allChainsData.byChain[c].deployed &&
          allChainsData.byChain[c].smartSessionsInstalled,
      ).length
    : 1;

  return (
    <>
      <Surface className="p-5 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold tracking-tight">
                Smart account
              </h2>
              <Badge tone="positive" dot>
                active
              </Badge>
            </div>
            <div className="mt-2 font-mono text-fg text-base">
              {shortAddress(data.safeAddress)}
            </div>
            <div className="mt-1 text-xs text-fg-subtle">
              active on {activeChainCount} of {SUPPORTED_CHAINS.length} chains ·{' '}
              {Number(formatEther(data.balance)).toFixed(4)} ETH on {data.chain}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="text-right text-xs text-fg-muted">
              <div>ALM: {sessions.data?.alm ? 'granted' : '—'}</div>
              <div>Executor: {sessions.data?.executor ? 'granted' : '—'}</div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAddingOwner(true)}
            >
              Add owner
            </Button>
          </div>
        </div>

        <CrossChainExpansion />
      </Surface>
      {addingOwner && <AddOwnerDialog onClose={() => setAddingOwner(false)} />}
    </>
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
