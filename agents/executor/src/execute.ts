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

const MOCK = (process.env.EXECUTOR_MOCK ?? '').toLowerCase() === 'true';

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

  // Mock path — short-circuit Uniswap + KeeperHub, write a synthetic
  // success receipt. Used when the demo target chain doesn't have
  // Uniswap Trading API support (Sepolia, Unichain Sepolia, etc.) but
  // we still want the dashboard to show end-to-end green.
  if (MOCK) {
    await sleep(800); // pretend we hit Uniswap + the bundler
    const txHash = synthTxHash(intentId);
    log.info('mock executed', { txHash, notionalUsd: intent.notionalUsd });

    await db().intent.update({
      where: { id: intentId },
      data: { status: 'executed' },
    });
    await db().event.create({
      data: {
        safeAddress,
        agent: 'executor',
        kind: 'intent.executed',
        payload: { intentId, txHash, mock: true },
      },
    });
    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      txHash: txHash as Hex,
      status: 'mined',
      blockNumber: 0n,
    };
    await ctx.axl
      .publish({
        topic: TOPICS.executorReceipt,
        payload: {
          fromAgent: 'executor',
          safeAddress,
          ts: Date.now(),
          payload: receipt,
        },
      })
      .catch(() => {
        // best-effort
      });
    return;
  }

  try {
    // 1. Session
    const session = await loadExecutorSession(safeAddress);
    if (!session) {
      throw new Error('No active Executor session for this Safe.');
    }

    // 2. Quote — Trading API builds a route assuming `swapper` is the
    //    address that will execute. Since KeeperHub broadcasts from its
    //    org-managed wallet, we pass that wallet's address (not the
    //    user's EOA) so Uniswap emits the right command list (e.g.
    //    WRAP_ETH from msg.value when the wallet only holds native ETH).
    //    Output recipient is still the user's EOA below via the route's
    //    embedded recipient parameter.
    log.info('quoting');
    const keeperhubWallet =
      (process.env.KEEPERHUB_WALLET_ADDRESS as `0x${string}` | undefined) ??
      safeAddress;
    const swap = await quote({
      chain: intent.chain,
      tokenIn: intent.tokenIn as `0x${string}`,
      tokenOut: intent.tokenOut as `0x${string}`,
      amountIn: intent.amountIn,
      swapper: keeperhubWallet,
      recipient: safeAddress,
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

    // 5. Submit. We pass the swap params (tokens + amount + recipient)
    //    so KH's `execute_protocol_action` can build the route itself —
    //    much more robust than handing it raw Universal Router calldata.
    //    The to/data/value/signature are kept for audit but ignored by
    //    the protocol-action path.
    log.info('submitting to keeperhub');
    const { jobId } = await submitJob({
      chain: intent.chain,
      smartAccount: safeAddress,
      to: swap.to,
      data: swap.data,
      value: swap.value,
      signature,
      metadata: { intentId, agent: 'executor' },
      swap: {
        tokenIn: intent.tokenIn as `0x${string}`,
        tokenOut: intent.tokenOut as `0x${string}`,
        amountIn: intent.amountIn,
        recipient: safeAddress,
      },
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic synthetic 32-byte hash derived from the intent id. */
function synthTxHash(intentId: string): string {
  return keccak256(
    encodePacked(['string', 'string'], ['mock-tx', intentId]),
  );
}
