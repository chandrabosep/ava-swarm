// Symbol → address resolution for the allowed token universe.
//
// Per-chain map. The Speedrun runs on avalanche-fuji, where the asset
// universe is AVAX (native) + USDC (stable) + a couple of Pangolin-liquid
// volatiles. Other chains are kept for back-compat.

import type { Address } from 'viem';
import type { SupportedChain } from '@swarm/shared';

// Symbols the swarm can route. PM is unbounded (can propose anything), so
// callers of resolve() must handle the `null` return for symbols outside
// the per-chain map.
export type Symbol =
  | 'ETH'
  | 'WETH'
  | 'WBTC'
  | 'USDC'
  | 'UNI'
  | 'AVAX'
  | 'WAVAX'
  | 'DAI'
  | 'JOE';

/** Symbol → contract address. Native assets (ETH, AVAX) resolve to the
 *  zero pseudo-address and are handled specially in resolve(). */
type ChainTokens = Partial<Record<string, Address>>;

const ETH_PSEUDO: Address = '0x0000000000000000000000000000000000000000';
/** Symbols that are the chain's native asset (no ERC-20 contract). */
const NATIVE_SYMBOLS = new Set(['ETH', 'AVAX']);

export const TOKENS: Record<SupportedChain, ChainTokens> = {
  mainnet: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  },
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    WBTC: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    UNI: '0xc3De830EA07524a0761646a6a4e4be0e114a3C83',
  },
  unichain: {
    WETH: '0x4200000000000000000000000000000000000006',
    WBTC: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    USDC: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    UNI: '0x8f187AA05619a017077f5308904739877ce9eA21',
  },
  sepolia: {
    WETH: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    WBTC: '0x29f2D40B0605204364af54EC677bD022dA425d03',
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  },
  'base-sepolia': {
    WETH: '0x4200000000000000000000000000000000000006',
    WBTC: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  },
  // Avalanche mainnet (.e bridged assets) — present for completeness.
  avalanche: {
    WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    WBTC: '0x50b7545627a5162F82A992c33b87aDc75187B218',
    UNI: '0x8eBAf22B6F053dFFeaf46f4Dd9eFA95D89ba8580',
  },
  // Avalanche Fuji (Speedrun target). Addresses verified on-chain; UNI/JOE
  // have liquid Pangolin pools, USDC is the Circle/x402 test token.
  'avalanche-fuji': {
    WAVAX: '0xd00ae08403B9bbb9124bB305C09058E32C39A48c',
    USDC: '0x5425890298aed601595a70AB815c96711a31Bc65',
    UNI: '0xf4E0A9224e8827dE91050b528F34e2F99C82Fbf6',
    JOE: '0xEa81F6972aDf76765Fd1435E119Acc0Aafc80BeA',
    DAI: '0x34B6C87bb59Eb37EFe35C8d594a234Cd8C654D50',
  },
};

/** Resolve a symbol → on-chain address for the given chain. Native assets
 *  (ETH, AVAX) return the zero pseudo-address. Returns null when we have no
 *  mapping (PM proposing a symbol we haven't catalogued on this chain);
 *  callers should drop those targets gracefully. */
export function resolve(
  symbol: string,
  chain: SupportedChain,
): Address | null {
  const sym = symbol.toUpperCase();
  if (NATIVE_SYMBOLS.has(sym)) return ETH_PSEUDO;
  const chainMap = TOKENS[chain];
  if (!chainMap) return null;
  return chainMap[sym] ?? null;
}
