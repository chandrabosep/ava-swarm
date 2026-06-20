// Target chains for the swarm. Mode is determined by USE_TESTNET in
// config/swarm.ts:
//   - production:  avalanche (C-Chain mainnet — optional Speedrun bonus)
//   - testnet:     avalanche-fuji (C-Chain testnet — the Speedrun target)
//
// Both lists are exported so callers that need either set (e.g. the
// explorer-URL helper) can pick deliberately.
//
// Speedrun: Agentic Payments runs on Fuji, so USE_TESTNET defaults the
// swarm to avalancheFuji. The agents-hire-agents x402 payments + ERC-8004
// identity/reputation all settle here.
import { avalanche, avalancheFuji } from 'wagmi/chains';

import { USE_TESTNET } from './swarm';

export const PROD_CHAINS = [avalanche] as const;
export const TESTNET_CHAINS = [avalancheFuji] as const;

export const chains = USE_TESTNET ? TESTNET_CHAINS : PROD_CHAINS;
export const defaultChain = USE_TESTNET ? avalancheFuji : avalanche;
