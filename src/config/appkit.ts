import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { sepolia, baseSepolia, unichainSepolia } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit/networks';

// Reown AppKit + Wagmi setup.
// Reference: https://docs.reown.com/appkit/react/core/installation
//
// VITE_REOWN_PROJECT_ID must be set (see .env.example). Get one at
// https://cloud.reown.com — free for dev usage.

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined;

if (!projectId) {
  console.warn(
    '[appkit] VITE_REOWN_PROJECT_ID is not set. Copy .env.example to .env and add a project id from https://cloud.reown.com',
  );
}

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  unichainSepolia,
  baseSepolia,
  sepolia,
];

export const wagmiAdapter = new WagmiAdapter({
  projectId: projectId ?? 'missing-project-id',
  networks,
  ssr: false,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

// IMPORTANT: dApp metadata.
//
// Wallet apps (and Reown's verify service) reject sessions when the metadata
// URL isn't a valid HTTPS origin. The new-tab page is served from
// chrome-extension://<id>, which wallets refuse to display. Always pass a
// real HTTPS URL here — it's what the user sees in their wallet's "Connect
// to: ..." prompt. Swap in your real domain when you have one.
const APP_URL = 'https://defi-swarm.app';
const APP_ICON =
  'https://raw.githubusercontent.com/EcosystemNetwork/Open/main/defi-swarm-newtab/public/icons/icon-128.png';

createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId: projectId ?? 'missing-project-id',
  metadata: {
    name: 'DeFi Swarm',
    description: 'New-tab dashboard for the DeFi agent swarm.',
    url: APP_URL,
    icons: [APP_ICON],
  },
  // Surface every connector we can. Modern MetaMask + most extension
  // wallets support EIP-6963 announcement on chrome-extension:// pages,
  // so users with the wallet installed can click "MetaMask" directly
  // without going through WalletConnect's QR flow.
  enableInjected: true,
  enableEIP6963: true,
  enableCoinbase: true,
  enableWalletConnect: true,
  features: {
    analytics: false,
    email: false,
    socials: [],
    swaps: false,
    onramp: false,
    history: false,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#7c5cff',
    '--w3m-border-radius-master': '4px',
  },
});
