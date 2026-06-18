// Read a wallet's Uniswap v4 LP positions from the canonical PositionManager.
//
// V4 represents positions as ERC-721 NFTs owned by the LP. We:
//   1. balanceOf(wallet) → how many positions the wallet holds
//   2. tokenOfOwnerByIndex(wallet, i) → tokenId of each
//   3. getPositionInfo(tokenId) → poolKey + tick range + liquidity
//
// The decoded shape is what strategy.ts consumes. We keep poolKey opaque
// here — strategy reads pool state through a separate quoter call.

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { mainnet, base, unichain } from 'viem/chains';

import { env } from '@swarm/shared';
import type { SupportedChain } from '@swarm/shared';

const VIEM_CHAIN = { mainnet, base, unichain } as const;

// Uniswap v4 PositionManager addresses (from docs.uniswap.org/contracts/v4/deployments).
export const POSITION_MANAGER: Record<SupportedChain, Address> = {
  mainnet: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
  base: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  unichain: '0x4529A01c7A0410167c5740C487A8DE60232617bf',
};

// Minimal ABI — only the bits we read from outside the SDK.
const POSITION_MANAGER_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (bytes32 poolId, int24 tickLower, int24 tickUpper, uint128 liquidity)',
]);

export interface RawPosition {
  tokenId: bigint;
  poolId: Hex;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export function clientFor(chain: SupportedChain): PublicClient {
  return createPublicClient({
    chain: VIEM_CHAIN[chain],
    transport: http(env.rpc(chain)),
  });
}

export async function readPositions(
  walletAddress: Address,
  chain: SupportedChain,
): Promise<RawPosition[]> {
  const client = clientFor(chain);
  const pm = POSITION_MANAGER[chain];

  // Bail cleanly if v4 PositionManager isn't deployed at this address on
  // this chain (rollout is uneven). Same outcome as "user has no
  // positions" — quiet return, no warning.
  const code = await client.getCode({ address: pm });
  if (!code || code === '0x') return [];

  const count = await client.readContract({
    address: pm,
    abi: POSITION_MANAGER_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  });

  if (count === 0n) return [];

  // Pull tokenIds in parallel.
  const tokenIds = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      client.readContract({
        address: pm,
        abi: POSITION_MANAGER_ABI,
        functionName: 'tokenOfOwnerByIndex',
        args: [walletAddress, BigInt(i)],
      }),
    ),
  );

  const positions = await Promise.all(
    tokenIds.map(async (tokenId) => {
      const [poolId, tickLower, tickUpper, liquidity] = await client.readContract({
        address: pm,
        abi: POSITION_MANAGER_ABI,
        functionName: 'getPoolAndPositionInfo',
        args: [tokenId],
      });
      return {
        tokenId,
        poolId,
        tickLower: Number(tickLower),
        tickUpper: Number(tickUpper),
        liquidity,
      } satisfies RawPosition;
    }),
  );

  return positions;
}
