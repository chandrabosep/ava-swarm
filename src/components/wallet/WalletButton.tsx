import { useEffect, useRef, useState } from 'react';
import { useAppKit } from '@reown/appkit/react';
import { useAccount, useDisconnect } from 'wagmi';
import { Button } from '@/components/common/Button';
import { shortAddress } from '@/lib/format';

// Custom connect/account button.
//
// Why not just use <appkit-button />? The web component renders empty when
// wagmi is in transient states (connecting / reconnecting after a dead WC
// session), making the button visually disappear. Driving render from React
// state guarantees we always show *something*.
//
// States we render:
//   - disconnected   → "Connect Wallet"           → opens AppKit Connect view
//   - connecting     → disabled "Connecting…"      → user just clicked, waiting
//   - reconnecting   → "Connect Wallet" (live)    → see below
//   - connected      → short address + ⏻ disconnect
//
// On extension new-tab pages, wagmi often gets stuck in `reconnecting` because
// the previous session was a WalletConnect socket that died with the page.
// Treating reconnecting as actionable (clickable) instead of a frozen spinner
// lets the user kick it loose without dev-tools.
export function WalletButton() {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAccount();
  const { disconnect } = useDisconnect();

  // After ~5s of `reconnecting` with nothing to show, surface a tiny hint that
  // they can just click Connect to restart the flow.
  const [reconnectLong, setReconnectLong] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (status === 'reconnecting') {
      timerRef.current = setTimeout(() => setReconnectLong(true), 5000);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      setReconnectLong(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [status]);

  const handleConnect = () => {
    // Wipe any stuck reconnect state first so we don't fight wagmi's pending
    // promise. If we're already disconnected this is a no-op.
    if (status === 'reconnecting') {
      try {
        disconnect();
      } catch {
        // ignore — we're about to open the modal regardless
      }
    }
    open({ view: 'Connect' });
  };

  if (status === 'connecting') {
    return (
      <Button variant="secondary" disabled className="w-full">
        Connecting…
      </Button>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex gap-2 w-full">
        <Button
          variant="secondary"
          className="flex-1 font-mono"
          onClick={() => open({ view: 'Account' })}
        >
          {shortAddress(address)}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => disconnect()}
          title="Disconnect"
        >
          ⏻
        </Button>
      </div>
    );
  }

  // disconnected OR reconnecting — both render an actionable Connect button.
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="primary"
        className="w-full"
        onClick={handleConnect}
      >
        Connect Wallet
      </Button>
      {status === 'reconnecting' && reconnectLong && (
        <p className="text-[11px] text-fg-subtle px-1">
          Restoring previous session — click to start fresh.
        </p>
      )}
    </div>
  );
}
