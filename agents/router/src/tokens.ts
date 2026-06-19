// Symbol → address resolution for the allowed token universe.
//
// Phase B-1 hardcodes a small map. Phase B-2+ should read this from a
// per-user "universe" config so different risk profiles can hold
// different tokens.

import type { Address } from 'viem';
import type { SupportedChain } from '@swarm/shared';

// Canonical short list with hard-coded addresses. PM is unbounded (can
// propose anything), so callers of resolve() must handle the `null`
// return for symbols outside this set.
export type Symbol = 'ETH' | 'WETH' | 'WBTC' | 'USDC' | 'UNI';

interface ChainTokens {
  /** "ETH" is special — no token address; Trading API accepts the zero address. */
  WETH: Address;
  WBTC: Address;
  USDC: Address;
  UNI: Address;
}

const ETH_PSEUDO: Address = '0x0000000000000000000000000000000000000000';

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
  // Sepolia — official Uniswap-deployed tokens. WBTC has thin/zero
  // liquidity on Sepolia; ETH↔USDC is the only reliable pair.
  sepolia: {
    WETH: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    WBTC: '0x29f2D40B0605204364af54EC677bD022dA425d03',
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  },
  'base-sepolia': {
    WETH: '0x4200000000000000000000000000000000000006',
    WBTC: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', // placeholder
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // placeholder
  },
};

/** Resolve a symbol → on-chain address for the given chain. Returns
 *  null when we don't have an address mapping (PM proposing exotic
 *  tokens like MATIC, SOL, etc on a chain where we haven't catalogued
 *  them). Callers should drop those targets gracefully. */
export function resolve(
  symbol: string,
  chain: SupportedChain,
): Address | null {
  if (symbol === 'ETH') return ETH_PSEUDO;
  const chainMap = TOKENS[chain];
  if (!chainMap) return null;
  const addr = (chainMap as unknown as Record<string, Address | undefined>)[symbol];
  return addr ?? null;
}
