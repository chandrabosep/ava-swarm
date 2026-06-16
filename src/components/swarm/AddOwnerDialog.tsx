import { useState } from 'react';
import { isAddress, type Address } from 'viem';

import { Surface } from '@/components/common/Surface';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useAddOwner } from '@/hooks/useAddOwner';

interface Props {
  onClose: () => void;
}

/**
 * Modal: paste an address, click confirm, sign one UserOp that calls
 * `addOwnerWithThreshold` on the Safe. Threshold stays at 1 for now —
 * the new owner becomes a co-signer with no required co-signature
 * (fast UX for first add). The user can promote to 2-of-2 later via
 * a follow-up call once they trust the second owner.
 */
export function AddOwnerDialog({ onClose }: Props) {
  const [address, setAddress] = useState('');
  const valid = isAddress(address);
  const { mutate, isPending, stage } = useAddOwner();

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onClose();
      }}
    >
      <Surface className="w-full max-w-md p-6 space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Add owner</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Add a second EOA / passkey / hardware wallet as a Safe owner.
              Threshold stays at 1 — both owners can sign solo. Promote to
              2-of-2 later for stronger protection.
            </p>
          </div>
          <Badge tone="accent">phase A</Badge>
        </header>

        <label className="block">
          <span className="text-xs text-fg-subtle">New owner address</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="mt-1 w-full bg-bg-hover border border-border rounded-md px-3 py-2 text-sm font-mono text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
            disabled={isPending}
          />
          {address.length > 0 && !valid && (
            <span className="text-[11px] text-negative">
              Not a valid address
            </span>
          )}
        </label>

        {stage.type === 'mined' && (
          <p className="text-xs text-positive font-mono break-all">
            Added in {stage.txHash}
          </p>
        )}
        {stage.type === 'failed' && (
          <p className="text-[11px] text-negative font-mono break-all">
            {stage.error.message}
          </p>
        )}

        <footer className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            {stage.type === 'mined' ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={() => mutate({ newOwner: address as Address, threshold: 1 })}
            disabled={!valid || isPending}
          >
            {isPending
              ? 'Signing…'
              : stage.type === 'mined'
                ? 'Done'
                : 'Add owner'}
          </Button>
        </footer>
      </Surface>
    </div>
  );
}
