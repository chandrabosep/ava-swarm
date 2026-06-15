import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'DeFi Swarm — New Tab',
  description:
    'New-tab dashboard for the DeFi agent swarm: portfolio, agents, intents.',
  version: pkg.version,
  // Override Chrome's new tab page with our dashboard.
  chrome_url_overrides: {
    newtab: 'index.html',
  },
  // Minimal permissions while we're shell-only. We'll add `alarms`,
  // `notifications`, etc. when agent runtime + KeeperHub land.
  permissions: ['storage', 'tabs'],
  // Reown AppKit + WalletConnect talk to:
  //   wss://relay.walletconnect.com   (WC v2 relay — required for sessions)
  //   https://api.web3modal.org       (Reown explorer / wallet metadata)
  //   https://pulse.walletconnect.org (Reown analytics, optional)
  //   https://verify.walletconnect.com (verify service)
  // Listing them in host_permissions lets the extension's network requests
  // bypass the regular cross-origin restrictions Chrome applies to extension
  // pages. If any of these are blocked, the WC session never opens and the
  // QR code stays blank — the most common cause of "QR doesn't show" reports.
  host_permissions: [
    'wss://relay.walletconnect.com/*',
    'https://relay.walletconnect.com/*',
    'https://api.web3modal.org/*',
    'https://pulse.walletconnect.org/*',
    'https://verify.walletconnect.com/*',
    'https://explorer-api.walletconnect.com/*',
  ],
  // Explicit CSP for extension pages. MV3 forbids 'unsafe-eval' and
  // 'unsafe-inline' on script-src — we don't try. We do explicitly allow
  // wasm-unsafe-eval (needed by some crypto libs) and widen connect-src to
  // every origin we use.
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline';",
  },
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: 'DeFi Swarm',
    default_icon: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
});
