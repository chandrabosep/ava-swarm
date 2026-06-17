// Execute a single RoutedIntent end-to-end:
//   1. Load the user's session keypair from DB.
//   2. Get a fresh quote from Uniswap.
//   3. Have Uniswap build the swap calldata.
//   4. Sign the resulting UserOp hash with the session key.
//   5. Submit to KeeperHub for guaranteed execution.
//   6. Wait for finalization, persist the receipt, publish on AXL.
//
// Each step has a clear failure mode. If any step throws, we record an
// `Intent.status = failed` with the error message and emit an
// `intent.failed` event for the dashboard to surface.

import { keccak256, encodePacked, type Hex } from 'viem';

import {
  db,
  TOPICS,
  type AgentContext,
  type ExecutionReceipt,
  type RoutedIntent,
  type SwarmMessage,
} from '@swarm/shared';

import { quote } from './uniswap.js';
import { submitJob, waitForJob } from './keeperhub.js';
import { loadExecutorSession } from './sessions.js';

export interface ExecuteParams {
  ctx: AgentContext;
  intentId: string;
  safeAddress: `0x${string}`;
  intent: RoutedIntent;
}

export async function execute({
  ctx,
  intentId,
  safeAddress,
  intent,
}: ExecuteParams): Promise<void> {
  const log = ctx.log.child({ intentId, safeAddress });

  await db().intent.update({
    where: { id: intentId },
    data: { status: 'executing' },
  });

  try {
    // 1. Session
    const session = await loadExecutorSession(safeAddress);
    if (!session) {
      throw new Error('No active Executor session for this Safe.');
    }

    // 2. Quote — single call. /quote returns methodParameters (Universal
    //    Router calldata) directly, no separate /swap hop.
    log.info('quoting');
    const swap = await quote({
      chain: intent.chain,
      tokenIn: intent.tokenIn as `0x${string}`,
      tokenOut: intent.tokenOut as `0x${string}`,
      amountIn: intent.amountIn,
      swapper: safeAddress,
    });

    // 4. Sign. We sign the keccak256 of (to, data, value, intentId) as a
    //    placeholder UserOp digest — KeeperHub does the actual UserOp
    //    construction and re-checks our signature against the recovered
    //    session-key address against the Smart Sessions module onchain.
    //    This keeps the agent dumb and KeeperHub authoritative.
    const digest = keccak256(
      encodePacked(
        ['address', 'bytes', 'uint256', 'string'],
        [swap.to, swap.data, BigInt(swap.value), intentId],
      ),
    );
    const signature = (await session.account.signMessage({
      message: { raw: digest as Hex },
    })) as Hex;

    // 5. Submit
    log.info('submitting to keeperhub');
    const { jobId } = await submitJob({
      chain: intent.chain,
      smartAccount: safeAddress,
      to: swap.to,
      data: swap.data,
      value: swap.value,
      signature,
      metadata: { intentId, agent: 'executor' },
    });
    log.info('keeperhub job created', { jobId });

    // 6. Wait + record
    const final = await waitForJob(jobId);
    if (final.status !== 'mined' || !final.txHash) {
      throw new Error(
        `KeeperHub job ${jobId} terminal status=${final.status} ${final.error ?? ''}`,
      );
    }

    await db().intent.update({
      where: { id: intentId },
      data: { status: 'executed' },
    });

    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      txHash: final.txHash,
      status: 'mined',
      blockNumber: final.blockNumber,
    };
    await db().event.create({
      data: {
        safeAddress,
        agent: 'executor',
        kind: 'intent.executed',
        payload: { intentId, txHash: final.txHash, jobId },
      },
    });

    const msg: SwarmMessage<ExecutionReceipt> = {
      fromAgent: 'executor',
      safeAddress,
      ts: Date.now(),
      payload: receipt,
    };
    await ctx.axl.publish({ topic: TOPICS.executorReceipt, payload: msg });
    log.info('executed', { txHash: final.txHash });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('execute failed', { message });
    await db().intent.update({
      where: { id: intentId },
      data: { status: 'failed' },
    });
    await db().event.create({
      data: {
        safeAddress,
        agent: 'executor',
        kind: 'intent.failed',
        payload: { intentId, message },
      },
    });
    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      status: 'failed',
      error: message,
    };
    await ctx.axl
      .publish({
        topic: TOPICS.executorReceipt,
        payload: { fromAgent: 'executor', safeAddress, ts: Date.now(), payload: receipt },
      })
      .catch(() => {
        // best-effort
      });
  }
}
