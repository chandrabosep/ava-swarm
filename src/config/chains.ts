// Target chains for the swarm. Mode is determined by USE_TESTNET in
// config/swarm.ts:
//   - production:  unichain, base, mainnet
//   - testnet:     sepolia, base-sepolia (Alchemy-indexed, KH-supported)
//
// Both lists are exported so callers that need either set (e.g. the
// explorer-URL helper) can pick deliberately.
import { base, baseSepolia, mainnet, sepolia, unichain } from 'wagmi/chains';

import { USE_TESTNET } from './swarm';

export const PROD_CHAINS = [unichain, base, mainnet] as const;
export const TESTNET_CHAINS = [sepolia, baseSepolia] as const;

export const chains = USE_TESTNET ? TESTNET_CHAINS : PROD_CHAINS;
export const defaultChain = USE_TESTNET ? sepolia : unichain;
