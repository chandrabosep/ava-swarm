// Wallet bar — network selector + connect button, top-right of the new-tab.
//
// New-tab extension pages don't need a full chrome — the user already has
// browser chrome above us. We just float the wallet controls on the right.
// Reown's <appkit-network-button /> + <appkit-button /> are registered by
// createAppKit() in src/config/appkit.ts.

export function Header() {
  return (
    <header className="h-14 px-6 flex items-center justify-end gap-2">
      <appkit-network-button />
      <appkit-button balance="hide" size="md" />
    </header>
  );
}
