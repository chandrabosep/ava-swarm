import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useSafeAllChains } from '@/hooks/useSafeAllChains';
import { useExpandToChain } from '@/hooks/useExpandToChain';
import { SUPPORTED_CHAINS, type SupportedChain } from '@/types/swarm';

const CHAIN_LABEL: Record<SupportedChain, string> = {
  unichain: 'Unichain',
  base: 'Base',
  mainnet: 'Mainnet',
};

/**
 * Per-chain status grid with "Activate on X" buttons. The Safe address is
 * the same everywhere by design; each chain just needs its own deploy +
 * module install + session re-grant cycle.
 */
export function CrossChainExpansion() {
  const all = useSafeAllChains();
  const expand = useExpandToChain();

  const data = all.data;
  if (!data) return null;

  return (
    <Surface variant="raised" className="p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold">Chains</h3>
        <span className="text-[11px] text-fg-subtle uppercase tracking-wider">
          same address everywhere
        </span>
      </div>
      <ul className="space-y-2 text-sm">
        {SUPPORTED_CHAINS.map((chain) => {
          const state = data.byChain[chain];
          const ready = state.deployed && state.smartSessionsInstalled;
          const targetingThis =
            (expand.stage.type === 'deploying' ||
              expand.stage.type === 'granting' ||
              expand.stage.type === 'switching') &&
            (expand.variables as SupportedChain | undefined) === chain;

          return (
            <li
              key={chain}
              className="flex items-center justify-between gap-3 px-1"
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">{CHAIN_LABEL[chain]}</span>
                {ready ? (
                  <Badge tone="positive" dot>
                    active
                  </Badge>
                ) : state.deployed ? (
                  <Badge tone="warning" dot>
                    module pending
                  </Badge>
                ) : (
                  <Badge tone="neutral" dot>
                    not deployed
                  </Badge>
                )}
              </span>
              {ready ? (
                <span className="text-[11px] text-fg-subtle">ready</span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => expand.mutate(chain)}
                  disabled={expand.isPending}
                >
                  {targetingThis ? 'In progress…' : 'Activate'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {expand.stage.type === 'failed' && (
        <p className="mt-3 text-[11px] text-negative font-mono break-all">
          {expand.stage.error.message}
        </p>
      )}
    </Surface>
  );
}
