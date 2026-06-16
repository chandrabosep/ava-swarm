import { useEffect } from 'react';
import { useAccount } from 'wagmi';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useSafe } from '@/hooks/useSafe';
import { useActivateSwarm } from '@/hooks/useActivateSwarm';
import { shortAddress } from '@/lib/format';

interface Props {
  onClose: () => void;
}

/**
 * Modal that walks the user through:
 *   1. preview — predicted Safe address + permissions summary
 *   2. signing — UserOps in flight (deploy, then ALM grant, then Executor grant)
 *   3. done    — green check, close button
 *
 * The actual work lives in useActivateSwarm; this is a presentation layer
 * that watches `stage` and renders the appropriate step.
 */
export function ActivateSwarmDialog({ onClose }: Props) {
  const { address: owner } = useAccount();
  const safe = useSafe();
  const { mutate, isPending, stage } = useActivateSwarm();

  // Auto-close 1.5s after success so the green check has time to register.
  useEffect(() => {
    if (stage.type === 'done') {
      const t = setTimeout(onClose, 1500);
      return () => clearTimeout(t);
    }
  }, [stage.type, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm p-6"
      onClick={(e) => {
        // Click on backdrop closes — but only if we're not mid-flight.
        if (e.target === e.currentTarget && !isPending) onClose();
      }}
    >
      <Surface className="w-full max-w-lg p-6 space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Activate Swarm</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Three on-chain operations, batched. You'll sign each via your
              wallet. No paymaster — your Safe pays its own gas after deploy.
            </p>
          </div>
          <Badge tone="accent">phase A</Badge>
        </header>

        <section className="space-y-3 text-sm">
          <Row
            label="Smart account address"
            value={
              safe.data ? (
                <span className="font-mono">
                  {shortAddress(safe.data.safeAddress)}
                </span>
              ) : (
                '…'
              )
            }
          />
          <Row label="Owner" value={owner ? shortAddress(owner) : '—'} />
          <Row
            label="Permissions"
            value={
              <span className="text-fg-muted">
                ALM: Uniswap v4 LP · Executor: Universal Router + Permit2
              </span>
            }
          />
          <Row
            label="Caps"
            value={
              <span className="text-fg-muted">
                $1,000 / tx · $10,000 / day · 25% LP shift / day
              </span>
            }
          />
          <Row
            label="Validity"
            value={<span className="text-fg-muted">7 days, manual renew</span>}
          />
        </section>

        <ProgressList stage={stage} />

        <footer className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isPending && stage.type !== 'failed' && stage.type !== 'done'}
          >
            {stage.type === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {stage.type !== 'done' && (
            <Button
              variant="primary"
              onClick={() => mutate()}
              disabled={isPending || !safe.data}
            >
              {stage.type === 'idle'
                ? 'Sign and activate'
                : stage.type === 'failed'
                  ? 'Retry'
                  : 'In progress…'}
            </Button>
          )}
        </footer>

        {stage.type === 'failed' && (
          <p className="text-[11px] text-negative font-mono break-all">
            {stage.error.message}
          </p>
        )}
      </Surface>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0">
      <span className="text-xs uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function ProgressList({
  stage,
}: {
  stage: ReturnType<typeof useActivateSwarm>['stage'];
}) {
  const steps = [
    {
      key: 'deploy',
      label: 'Deploy Safe + install Smart Sessions',
      done:
        stage.type === 'granting' ||
        stage.type === 'done' ||
        (stage.type === 'deploying' && stage.stage.type === 'mined'),
      active: stage.type === 'deploying',
    },
    {
      key: 'alm',
      label: 'Grant ALM session',
      done:
        stage.type === 'done' ||
        (stage.type === 'granting' &&
          (stage.agent === 'executor' ||
            (stage.agent === 'alm' && stage.stage.type === 'mined'))),
      active: stage.type === 'granting' && stage.agent === 'alm',
    },
    {
      key: 'executor',
      label: 'Grant Executor session',
      done: stage.type === 'done',
      active: stage.type === 'granting' && stage.agent === 'executor',
    },
  ];
  return (
    <ul className="text-xs space-y-1.5">
      {steps.map((s) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={
              s.done
                ? 'text-positive'
                : s.active
                  ? 'text-accent'
                  : 'text-fg-subtle'
            }
          >
            {s.done ? '✓' : s.active ? '…' : '○'}
          </span>
          <span
            className={
              s.done
                ? 'text-fg-muted line-through'
                : s.active
                  ? 'text-fg'
                  : 'text-fg-muted'
            }
          >
            {s.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
