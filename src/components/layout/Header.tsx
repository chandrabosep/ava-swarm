// Header — logo, network selector, wallet connect button.
//
// We use Reown's <appkit-button /> custom element for connect, and
// <appkit-network-button /> for the network selector. They render and theme
// themselves; createAppKit() in src/config/appkit.ts is what registers them.

export function Header() {
  return (
    <header className="h-14 px-6 flex items-center justify-between border-b border-border bg-bg/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <Logo />
        <span className="text-sm font-semibold tracking-tight">DeFi Swarm</span>
        <span className="ml-2 text-[11px] uppercase tracking-wider text-fg-subtle border border-border-subtle rounded px-1.5 py-0.5">
          shell
        </span>
      </div>

      <div className="flex items-center gap-2">
        <appkit-network-button />
        <appkit-button balance="hide" size="md" />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <div className="size-7 rounded-md bg-gradient-to-br from-accent to-accent/40 grid place-items-center text-[11px] font-bold text-white">
      ◊
    </div>
  );
}
