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
  permissions: ['storage', 'tabs'],
  host_permissions: [
    // Reown / WalletConnect
    'wss://relay.walletconnect.com/*',
    'https://relay.walletconnect.com/*',
    'https://api.web3modal.org/*',
    'https://pulse.walletconnect.org/*',
    'https://verify.walletconnect.com/*',
    'https://explorer-api.walletconnect.com/*',
    // Zerion proxy (Cloudflare Workers). Wildcard so any *.workers.dev URL
    // matches — saves having to update the manifest every time the proxy
    // subdomain changes during deploy / re-deploy.
    'https://*.workers.dev/*',
    // (Optional, legacy) Direct Zerion access — only useful from the SW
    // context which we don't use. Kept so a future content-script proxy
    // can rely on it.
    'https://api.zerion.io/*',
    // Pimlico — ERC-4337 bundler for the Safe smart account.
    'https://api.pimlico.io/*',
    'https://*.pimlico.io/*',
    // Safe Transaction Service — used to read Safe state (owners, modules,
    // pending transactions) without RPC scanning.
    'https://safe-transaction-mainnet.safe.global/*',
    'https://safe-transaction-base.safe.global/*',
    'https://safe-transaction-unichain.safe.global/*',
    // Public RPCs we hit from the page for Safe address prediction and
    // deployment-state checks. Keep narrow rather than `https://*` so the
    // permissions prompt is honest about what we touch.
    'https://eth.llamarpc.com/*',
    'https://base.llamarpc.com/*',
    'https://unichain.drpc.org/*',
    'https://mainnet.unichain.org/*',
  ],
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
