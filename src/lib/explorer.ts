// Chain-aware block-explorer URL builders.
//
// The dashboard renders intent.executed events and x402 payment receipts
// with txHashes that land on Avalanche C-Chain (mainnet) or Fuji (testnet).
// Without a chain-aware helper every link would point at the wrong explorer
// and break for the chain the swarm actually runs on.

import { USE_TESTNET } from '@/config/swarm';

export type ChainSlug = 'avalanche' | 'avalanche-fuji';

const EXPLORER: Record<ChainSlug, string> = {
  avalanche: 'https://snowtrace.io',
  'avalanche-fuji': 'https://testnet.snowtrace.io',
};

/**
 * Default chain when a payload doesn't explicitly tell us which chain its
 * tx landed on. Mirrors USE_TESTNET so demo links don't mismatch reality.
 */
export const defaultExplorerChain: ChainSlug = USE_TESTNET
  ? 'avalanche-fuji'
  : 'avalanche';

/** `https://<explorer>/tx/<hash>` for the given chain. */
export function txUrl(
  hash: string,
  chain: ChainSlug = defaultExplorerChain,
): string {
  const base = EXPLORER[chain] ?? EXPLORER['avalanche-fuji'];
  return `${base}/tx/${hash}`;
}

/** `https://<explorer>/address/<addr>`. */
export function addressUrl(
  addr: string,
  chain: ChainSlug = defaultExplorerChain,
): string {
  const base = EXPLORER[chain] ?? EXPLORER['avalanche-fuji'];
  return `${base}/address/${addr}`;
}

/** Pretty chain label for badges (e.g. "Avalanche", "Fuji"). */
export function chainLabel(chain: ChainSlug): string {
  switch (chain) {
    case 'avalanche':
      return 'Avalanche';
    case 'avalanche-fuji':
      return 'Fuji';
  }
}
