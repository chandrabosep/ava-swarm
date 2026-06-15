import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, base, unichain } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit/networks';

// Reown AppKit + Wagmi setup, mirroring
// https://docs.reown.com/appkit/react/core/installation
//
// IMPORTANT: VITE_REOWN_PROJECT_ID must be set (see .env.example). Get one at
// https://cloud.reown.com — it's free for the dev tier we're on.

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined;

if (!projectId) {
  // We don't throw — that would prevent the dashboard shell from rendering at
  // all. Instead we surface a clear console warning and the wallet button will
  // open a modal that explains the missing project id.
  console.warn(
    '[appkit] VITE_REOWN_PROJECT_ID is not set. Copy .env.example to .env and add a project id from https://cloud.reown.com',
  );
}

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  unichain,
  base,
  mainnet,
];

export const wagmiAdapter = new WagmiAdapter({
  projectId: projectId ?? 'missing-project-id',
  networks,
  ssr: false,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

// `createAppKit` registers the <appkit-button /> custom element and wires up
// the modal. It must be called once at module-load time, before any
// <appkit-button /> renders.
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId: projectId ?? 'missing-project-id',
  metadata: {
    name: 'DeFi Swarm — New Tab',
    description: 'New-tab dashboard for the DeFi agent swarm.',
    // Extension pages don't have a meaningful URL, but Reown wants strings.
    url: 'https://defi-swarm.local',
    icons: [],
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#7c5cff',
    '--w3m-border-radius-master': '4px',
  },
});
