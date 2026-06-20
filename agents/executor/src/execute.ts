// Execute a single RoutedIntent.
//
// On Avalanche the executor's own service key is the treasury: it performs a
// REAL Pangolin swap on Fuji (see pangolin.ts) and records the on-chain tx
// hash (resolvable on Snowtrace). Any other chain falls back to a simulated
// receipt (no venue wired there).
//
// Flow: mark executing → real swap (or simulate) → confirm receipt → persist
// `executed` + emit `intent.executed` with the tx hash → publish on the mesh.

import { keccak256, encodePacked, type Hex } from 'viem';

import {
  db,
  TOPICS,
  type AgentContext,
  type ExecutionReceipt,
  type RoutedIntent,
  type SwarmMessage,
} from '@swarm/shared';

import { swapOnPangolin, fujiClient } from './pangolin.js';

const AVALANCHE_CHAINS = new Set(['avalanche-fuji', 'avalanche']);

export interface ExecuteParams {
  ctx: AgentContext;
  intentId: string;
  walletAddress: `0x${string}`;
  intent: RoutedIntent;
}

export async function execute({
  ctx,
  intentId,
  walletAddress,
  intent,
}: ExecuteParams): Promise<void> {
  const log = ctx.log.child({ intentId, walletAddress });

  await db().intent.update({
    where: { id: intentId },
    data: { status: 'executing' },
  });

  try {
    let txHash: string;

    if (AVALANCHE_CHAINS.has(intent.chain)) {
      // REAL swap from the treasury wallet on Pangolin.
      log.info('swapping on pangolin', {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn,
        notionalUsd: intent.notionalUsd,
      });
      const hash = await swapOnPangolin({
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: BigInt(intent.amountIn),
      });
      const receipt = await fujiClient().waitForTransactionReceipt({
        hash,
        timeout: 90_000,
      });
      if (receipt.status !== 'success') {
        throw new Error(`swap tx ${hash} reverted on ${intent.chain}`);
      }
      txHash = hash;
      log.info('swap landed', { txHash, block: Number(receipt.blockNumber) });
    } else {
      // No venue on this chain — simulate.
      await sleep(600);
      txHash = synthTxHash(intentId);
      log.info('executed (simulated)', { txHash, chain: intent.chain });
    }

    await db().intent.update({
      where: { id: intentId },
      data: { status: 'executed' },
    });
    await db().event.create({
      data: {
        walletAddress,
        agent: 'executor',
        kind: 'intent.executed',
        payload: {
          intentId,
          txHash,
          chain: intent.chain,
          simulated: !AVALANCHE_CHAINS.has(intent.chain),
        },
      },
    });

    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      txHash: txHash as Hex,
      status: 'mined',
      blockNumber: 0,
    };
    const msg: SwarmMessage<ExecutionReceipt> = {
      fromAgent: 'executor',
      walletAddress,
      ts: Date.now(),
      payload: receipt,
    };
    await ctx.axl
      .publish({ topic: TOPICS.executorReceipt, payload: msg })
      .catch(() => {
        /* best-effort */
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('execute failed', { message });
    await db().intent.update({
      where: { id: intentId },
      data: { status: 'failed' },
    });
    await db().event.create({
      data: {
        walletAddress,
        agent: 'executor',
        kind: 'intent.failed',
        payload: { intentId, message: scrub(message) },
      },
    });
    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      status: 'failed',
      error: scrub(message),
    };
    await ctx.axl
      .publish({
        topic: TOPICS.executorReceipt,
        payload: { fromAgent: 'executor', walletAddress, ts: Date.now(), payload: receipt },
      })
      .catch(() => {
        /* best-effort */
      });
    // Re-throw so intent-poll keeps the `failed` status.
    throw err;
  }
}

/** User-safe error surface. */
function scrub(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'swap failed — treasury balance too low';
  if (m.includes('liquidity') || m.includes('zero quote')) return 'swap failed — no liquidity for this pair';
  if (m.includes('reverted')) return 'swap failed — transaction reverted on-chain';
  return 'swap failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic synthetic hash for the simulated (non-Avalanche) path. */
function synthTxHash(intentId: string): string {
  return keccak256(encodePacked(['string', 'string'], ['sim-tx', intentId]));
}
