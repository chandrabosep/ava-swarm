// Target chains for the swarm. Unichain is the primary execution surface;
// Base and Mainnet are kept in the picker for cross-chain views and for
// testnet-style smoke testing during dev.
import { mainnet, base, unichain } from 'wagmi/chains';

export const chains = [unichain, base, mainnet] as const;

export const defaultChain = unichain;
