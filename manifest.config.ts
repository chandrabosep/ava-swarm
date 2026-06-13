import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'DeFi Swarm — New Tab',
  description:
    'New-tab dashboard for the DeFi agent swarm: portfolio, agents, intents, and market news.',
  version: pkg.version,
  // Override Chrome's new tab page with our dashboard.
  chrome_url_overrides: {
    newtab: 'index.html',
  },
  // Minimal permissions while we're shell-only. We'll add `alarms`,
  // `notifications`, etc. when agent runtime + KeeperHub land.
  permissions: ['storage', 'tabs'],
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
