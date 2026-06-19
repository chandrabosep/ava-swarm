import { useEffect } from 'react';
import { useAccount } from 'wagmi';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useDelegateSwarm } from '@/hooks/useDelegateSwarm';
import { defaultScopes } from '@/lib/delegation';
import { shortAddress } from '@/lib/format';

interface Props {
  onClose: () => void;
}

/**
 * Modal that walks the user through a single-signature swarm delegation
 * (EIP-7702 / Calibur-style). No transactions, no funding, just one
 * EIP-712 signature.
 */
export function DelegateSwarmDialog({ onClose }: Props) {
  const { address: owner } = useAccount();
  const { mutate, isPending, stage, demoMode } = useDelegateSwarm();

  // Auto-close 1.5s after success.
  useEffect(() => {
    if (stage.type === 'done') {
      const t = setTimeout(onClose, 1500);
      return () => clearTimeout(t);
    }
  }, [stage.type, onClose]);

  const scopes = defaultScopes();

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onClose();
      }}
    >
      <Surface className="w-full max-w-lg p-6 space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Delegate Swarm</h2>
            <p className="mt-1 text-xs text-fg-muted">
              One EIP-712 signature delegates scoped authority to the four
              agents. Funds never leave your EOA — your address gains smart
              account behavior via EIP-7702, no migration needed.
            </p>
          </div>
          <Badge tone="accent">7702</Badge>
        </header>

        <section className="space-y-3 text-sm">
          <Row label="Account" value={owner ? shortAddress(owner) : '—'} />
          <Row
            label="Validity"
            value={<span className="text-fg-muted">30 days, revocable</span>}
          />
          <Row
            label="Authorized scopes"
            value={
              <ul className="text-right space-y-1 text-xs text-fg-muted">
                {scopes.map((s) => (
                  <li key={`${s.target}-${s.selector}`}>{s.label}</li>
                ))}
              </ul>
            }
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
              disabled={isPending || !owner}
            >
              {stage.type === 'idle' || stage.type === 'failed'
                ? demoMode
                  ? 'Delegate (demo)'
                  : 'Sign delegation'
                : labelFor(stage)}
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

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-2 last:border-0">
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
  stage: ReturnType<typeof useDelegateSwarm>['stage'];
}) {
  const steps = [
    {
      key: 'sign',
      label: 'Sign delegation',
      done:
        stage.type === 'done' ||
        stage.type === 'registering',
      active:
        stage.type === 'building' ||
        stage.type === 'awaiting-signature',
    },
    {
      key: 'register',
      label: 'Register with agent runtime',
      done: stage.type === 'done',
      active: stage.type === 'registering',
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

function labelFor(stage: ReturnType<typeof useDelegateSwarm>['stage']): string {
  switch (stage.type) {
    case 'building':
      return 'Building…';
    case 'awaiting-signature':
      return 'Awaiting signature…';
    case 'registering':
      return `Registering ${stage.agent}…`;
    default:
      return 'In progress…';
  }
}
