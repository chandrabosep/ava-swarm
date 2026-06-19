// Chain-aware block-explorer URL builders.
//
// The dashboard renders intent.executed events with txHashes that may
// have landed on any of the supported chains (mainnet, base, sepolia,
// base-sepolia). Without a chain-aware helper every link would point at
// etherscan.io and break for testnet receipts.

import { USE_TESTNET } from '@/config/swarm';

export type ChainSlug =
  | 'mainnet'
  | 'base'
  | 'unichain'
  | 'sepolia'
  | 'base-sepolia';

const EXPLORER: Record<ChainSlug, string> = {
  mainnet: 'https://etherscan.io',
  base: 'https://basescan.org',
  unichain: 'https://uniscan.xyz',
  sepolia: 'https://sepolia.etherscan.io',
  'base-sepolia': 'https://sepolia.basescan.org',
};

/**
 * Default chain when an intent's payload doesn't explicitly tell us
 * which chain its tx landed on. Mirrors USE_TESTNET so demo links don't
 * mismatch reality.
 */
export const defaultExplorerChain: ChainSlug = USE_TESTNET
  ? 'sepolia'
  : 'mainnet';

/** `https://<explorer>/tx/<hash>` for the given chain. */
export function txUrl(
  hash: string,
  chain: ChainSlug = defaultExplorerChain,
): string {
  const base = EXPLORER[chain] ?? EXPLORER.mainnet;
  return `${base}/tx/${hash}`;
}

/** `https://<explorer>/address/<addr>`. */
export function addressUrl(
  addr: string,
  chain: ChainSlug = defaultExplorerChain,
): string {
  const base = EXPLORER[chain] ?? EXPLORER.mainnet;
  return `${base}/address/${addr}`;
}

/** Pretty chain label for badges (e.g. "Sepolia", "Base Sepolia"). */
export function chainLabel(chain: ChainSlug): string {
  switch (chain) {
    case 'mainnet':
      return 'Ethereum';
    case 'base':
      return 'Base';
    case 'unichain':
      return 'Unichain';
    case 'sepolia':
      return 'Sepolia';
    case 'base-sepolia':
      return 'Base Sepolia';
  }
}
