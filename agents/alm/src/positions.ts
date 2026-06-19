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
import { mainnet, base, unichain, sepolia, baseSepolia } from 'viem/chains';

import { env } from '@swarm/shared';
import type { SupportedChain } from '@swarm/shared';

const VIEM_CHAIN = {
  mainnet,
  base,
  unichain,
  sepolia,
  'base-sepolia': baseSepolia,
} as const satisfies Record<SupportedChain, unknown>;

// Uniswap v4 PositionManager addresses (from docs.uniswap.org/contracts/v4/deployments).
// Testnet entries use the official Sepolia v4 deployments where they exist;
// 0x0 placeholders mean "v4 not deployed on this chain yet" — readPositions
// will short-circuit for those.
export const POSITION_MANAGER: Record<SupportedChain, Address> = {
  mainnet: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
  base: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  unichain: '0x4529A01c7A0410167c5740C487A8DE60232617bf',
  // Uniswap v4 Sepolia PositionManager (per docs.uniswap.org/contracts/v4/deployments).
  sepolia: '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4',
  'base-sepolia': '0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80',
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
  // Lose the precise return type — viem's exported `PublicClient` is
  // a different generic instantiation than what `createPublicClient`
  // returns (TS2719 mismatch). Inferring works fine at the call site.
  return createPublicClient({
    chain: VIEM_CHAIN[chain],
    transport: http(env.rpc(chain)),
  }) as unknown as PublicClient;
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
