// Risk profile picker.
//
// Four canonical profiles drive the PM's prompt + tolerance + cadence:
//   conservative  — capital preservation, stables-heavy, hourly
//   balanced      — diversified moderate growth, every 30min (default)
//   aggressive    — growth tilt, low stables, 5-min cadence
//   degen         — no floor, max momentum, 1-min cadence
//
// Update lands in the agents DB via PUT /api/users/:wallet/profile and
// the next PM tick reads it.

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { setRiskProfile } from '@/lib/agents-api';
import { useSwarmStatus, type RiskProfile } from '@/hooks/useSwarmStatus';

const PROFILES: Array<{
  key: RiskProfile;
  label: string;
  blurb: string;
  cadence: string;
}> = [
  {
    key: 'conservative',
    label: 'Conservative',
    blurb: '60% stables · max 40% per token · 10% drift before trade',
    cadence: 'every 1h',
  },
  {
    key: 'balanced',
    label: 'Balanced',
    blurb: '20% stables · max 50% per token · 5% drift',
    cadence: 'every 30m',
  },
  {
    key: 'aggressive',
    label: 'Aggressive',
    blurb: '5% stables · max 70% per token · 2% drift',
    cadence: 'every 5m',
  },
  {
    key: 'degen',
    label: 'Degen',
    blurb: 'no floor · max 95% per token · 1% drift',
    cadence: 'every 1m',
  },
];

export function RiskProfileCard() {
  const { address: owner } = useAccount();
  const status = useSwarmStatus();
  const qc = useQueryClient();
  const current = status.data?.riskProfile ?? 'balanced';
  const [pending, setPending] = useState<RiskProfile | null>(null);

  const mutation = useMutation({
    mutationFn: async (profile: RiskProfile) => {
      if (!owner) throw new Error('wallet not connected');
      setPending(profile);
      // Switching presets clears any per-knob overrides — keeps the UX
      // simple: pick a preset, get exactly that preset.
      await setRiskProfile(owner, profile, { resetCustom: true });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ['swarm-status'] });
    },
  });

  if (!owner) return null;

  return (
    <Surface className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Risk profile</h2>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed max-w-xl">
            Drives PM's prompt, rebalance threshold, and tick cadence. Switch
            anytime — agents pick up the new profile on the next tick.
          </p>
        </div>
        <Badge tone="accent">{current}</Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {PROFILES.map((p) => {
          const active = current === p.key;
          const loading = pending === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => mutation.mutate(p.key)}
              disabled={mutation.isPending || active}
              className={[
                'text-left rounded-md border p-3 transition-colors',
                active
                  ? 'border-accent bg-accent/10'
                  : 'border-border-subtle hover:border-border bg-bg-raised',
                mutation.isPending && !active ? 'opacity-50' : '',
              ].join(' ')}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-sm font-medium ${active ? 'text-accent' : 'text-fg'}`}
                >
                  {p.label}
                </span>
                {loading && (
                  <span className="text-[10px] text-fg-subtle">saving…</span>
                )}
                {active && !loading && (
                  <span className="text-[10px] text-positive">active</span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-fg-muted leading-relaxed">
                {p.blurb}
              </p>
              <p className="mt-1 text-[10px] text-fg-subtle uppercase tracking-wider">
                {p.cadence}
              </p>
            </button>
          );
        })}
      </div>
    </Surface>
  );
}
