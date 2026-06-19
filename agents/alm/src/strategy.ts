// Rebalance heuristics.
//
// Three rules we apply per position:
//   1. OUT_OF_RANGE — current pool tick is outside [tickLower, tickUpper].
//      Position earns no fees in this state, so we want to move the range
//      to bracket the current tick.
//   2. NEAR_BOUNDARY — current tick is within RANGE_BUFFER_BPS of either
//      bound. We don't act yet but flag for the next tick.
//   3. IDLE — position is healthy, no action needed.
//
// The actual swap that backs a rebalance (e.g. burning USDC-heavy
// position and re-minting around the new tick using ETH from elsewhere)
// is decomposed into a RebalanceIntent, handed off to Router, and
// settled by Executor. ALM doesn't sign onchain itself — it just
// notices and proposes.

import { parseAbi, type Hex } from 'viem';

import type { SupportedChain } from '@swarm/shared';
import { clientFor } from './positions.js';
import type { RawPosition } from './positions.js';

export type Verdict = 'out-of-range' | 'near-boundary' | 'idle';

export interface PositionAnalysis {
  position: RawPosition;
  verdict: Verdict;
  /** Current pool tick, for the rebalance intent. */
  currentTick: number;
}

const POOL_MANAGER_ABI = parseAbi([
  // V4 storage extsload — we read slot for `slot0` via the canonical
  // helper. Real implementation would use the v4-sdk's StateView.
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

const POOL_MANAGER: Record<SupportedChain, `0x${string}`> = {
  mainnet: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  base: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  unichain: '0x1F98400000000000000000000000000000000004',
  // Sepolia v4 PoolManager (per docs.uniswap.org/contracts/v4/deployments).
  sepolia: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  'base-sepolia': '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
};

/** Trigger rebalance if current tick is within this many ticks of a bound. */
const NEAR_BOUNDARY_TICKS = 50;

export async function analyzePositions(
  positions: RawPosition[],
  chain: SupportedChain,
): Promise<PositionAnalysis[]> {
  const client = clientFor(chain);
  const pm = POOL_MANAGER[chain];

  return await Promise.all(
    positions.map(async (position) => {
      const [, tick] = await client.readContract({
        address: pm,
        abi: POOL_MANAGER_ABI,
        functionName: 'getSlot0',
        args: [position.poolId as Hex],
      });
      const currentTick = Number(tick);
      const verdict = classify(position, currentTick);
      return { position, verdict, currentTick };
    }),
  );
}

function classify(p: RawPosition, currentTick: number): Verdict {
  if (currentTick < p.tickLower || currentTick > p.tickUpper) {
    return 'out-of-range';
  }
  const distLower = currentTick - p.tickLower;
  const distUpper = p.tickUpper - currentTick;
  if (
    Math.min(distLower, distUpper) <= NEAR_BOUNDARY_TICKS
  ) {
    return 'near-boundary';
  }
  return 'idle';
}
