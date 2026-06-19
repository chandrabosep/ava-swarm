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
import { publicClientForChain, type ChainName } from './onchain.js';
import { loadExecutorSession } from './sessions.js';

/**
 * Defence against KH returning a structurally-valid txHash that points
 * at a reverted transaction or an unrelated tx (sequencer race, fake
 * upstream, replayed hash). After KH says "mined" we re-fetch the
 * receipt from the chain's RPC and assert success — only then mark
 * the intent executed.
 *
 * Returns the receipt's blockNumber on success; throws otherwise.
 */
async function assertReceiptSuccess(
  chain: string,
  txHash: `0x${string}`,
): Promise<bigint> {
  const client = publicClientForChain(chain as ChainName);
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
    retryCount: 3,
  });
  if (receipt.status !== 'success') {
    throw new Error(
      `tx ${txHash} on ${chain} reverted (status=${receipt.status}, block=${receipt.blockNumber})`,
    );
  }
  return receipt.blockNumber;
}

// Mock-execution gate. Default false — we want REAL execution on
// every chain, including testnets. Set EXECUTOR_MOCK=true only when
// you explicitly want to short-circuit Uniswap + KeeperHub for a
// pure-UI demo (e.g. recording a video without funding the KH wallet).
const MOCK = (process.env.EXECUTOR_MOCK ?? '').toLowerCase() === 'true';

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
        walletAddress,
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
      blockNumber: 0,
    };
    await ctx.axl
      .publish({
        topic: TOPICS.executorReceipt,
        payload: {
          fromAgent: 'executor',
          walletAddress,
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
    const session = await loadExecutorSession(walletAddress);
    if (!session) {
      throw new Error('No active Executor session for this wallet.');
    }

    // 1b. Sanity-check tokens against chain. Stale intents from before
    //     the chain rename can have chain='sepolia' but tokenIn=mainnet
    //     USDC address, which 100% can't execute. Fail fast with a
    //     clear message instead of letting KH return an opaque
    //     "balance 0" error.
    if (!isAddressOnChain(intent.tokenIn, intent.chain)) {
      throw new Error(
        `Token ${intent.tokenIn} is not a known address on chain ${intent.chain}. Stale intent — re-run cleanup-fake-executed.ts.`,
      );
    }
    if (!isAddressOnChain(intent.tokenOut, intent.chain)) {
      throw new Error(
        `Token ${intent.tokenOut} is not a known address on chain ${intent.chain}. Stale intent.`,
      );
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
      walletAddress;
    const swap = await quote({
      chain: intent.chain,
      tokenIn: intent.tokenIn as `0x${string}`,
      tokenOut: intent.tokenOut as `0x${string}`,
      amountIn: intent.amountIn,
      swapper: keeperhubWallet,
      recipient: walletAddress,
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
      smartAccount: walletAddress,
      to: swap.to,
      data: swap.data,
      value: swap.value,
      signature,
      metadata: { intentId, agent: 'executor' },
      swap: {
        tokenIn: intent.tokenIn as `0x${string}`,
        tokenOut: intent.tokenOut as `0x${string}`,
        amountIn: intent.amountIn,
        recipient: walletAddress,
      },
    });
    log.info('keeperhub job created', { jobId });

    // 6. Wait + record. Defensive: KH has been observed to return
    //    status=completed with `transactionHash: ""` or `transactionHash`
    //    that's a stub like "0x" (race between job-completion event and
    //    its tx-hash indexer). Reject anything that isn't a full
    //    32-byte hex hash so we never write `executed` without a real
    //    onchain receipt.
    const final = await waitForJob(jobId);
    const looksLikeRealTx =
      typeof final.txHash === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(final.txHash);
    if (final.status !== 'mined' || !looksLikeRealTx) {
      throw new Error(
        `KeeperHub job ${jobId} terminal status=${final.status} txHash=${
          final.txHash ?? '∅'
        } ${final.error ?? ''}`,
      );
    }

    // Independent on-chain confirmation — KH telling us "mined" with a
    // valid-looking hash isn't enough; we have to confirm the tx
    // succeeded and isn't a stale or unrelated hash.
    const txHash = final.txHash as `0x${string}`;
    const blockNumber = await assertReceiptSuccess(intent.chain, txHash);
    log.info('on-chain receipt confirmed', {
      txHash,
      blockNumber: Number(blockNumber),
    });

    await db().intent.update({
      where: { id: intentId },
      data: { status: 'executed' },
    });

    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      txHash,
      status: 'mined',
      blockNumber: Number(blockNumber),
    };
    await db().event.create({
      data: {
        walletAddress,
        agent: 'executor',
        kind: 'intent.executed',
        payload: { intentId, txHash: final.txHash, jobId },
      },
    });

    const msg: SwarmMessage<ExecutionReceipt> = {
      fromAgent: 'executor',
      walletAddress,
      ts: Date.now(),
      payload: receipt,
    };
    await ctx.axl.publish({ topic: TOPICS.executorReceipt, payload: msg });
    log.info('executed', { txHash: final.txHash });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Internal log keeps the full message for debugging.
    log.error('execute failed', { message });
    // User-facing surfaces (AXL receipt, dashboard event) get a
    // scrubbed version: token addresses and our KNOWN_TOKENS hint
    // shouldn't leak into the activity feed where they help an
    // attacker probe the executor's whitelist shape.
    const userMessage = scrubExecutionError(message);
    await db().intent.update({
      where: { id: intentId },
      data: { status: 'failed' },
    });
    await db().event.create({
      data: {
        walletAddress,
        agent: 'executor',
        kind: 'intent.failed',
        payload: { intentId, message: userMessage },
      },
    });
    const receipt: ExecutionReceipt = {
      kind: 'receipt',
      intentId,
      status: 'failed',
      error: userMessage,
    };
    await ctx.axl
      .publish({
        topic: TOPICS.executorReceipt,
        payload: { fromAgent: 'executor', walletAddress, ts: Date.now(), payload: receipt },
      })
      .catch(() => {
        // best-effort
      });
    // CRITICAL: re-throw so intent-poll knows the handler failed and
    // doesn't overwrite our `failed` status with `executed`. Without
    // this, every onchain failure (insufficient balance, no liquidity,
    // KH error) would silently appear as an "executed" intent with no
    // txHash — which is misleading and worse than just showing failure.
    throw err;
  }
}

/**
 * Reduce an internal error string to a user-safe surface. Strips:
 *   - 0x… addresses (token allowlist probe surface)
 *   - File paths and module names
 *   - References to KNOWN_TOKENS / cleanup scripts (developer hints)
 *   - KH/Uniswap internal endpoint shape leaks
 *
 * The full message stays in the agent log; the dashboard sees a
 * generic outcome only.
 */
function scrubExecutionError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('insufficient') && lower.includes('balance')) {
    return 'swap failed — wallet does not hold enough of the input token';
  }
  if (lower.includes('not a known address') || lower.includes('stale intent')) {
    return 'swap failed — token not supported on this chain';
  }
  if (lower.includes('no active executor session') || lower.includes('session')) {
    return 'swap failed — no active session for this wallet';
  }
  if (lower.includes('reverted') || lower.includes('status=reverted')) {
    return 'swap failed — transaction reverted on-chain';
  }
  if (lower.includes('keeperhub') || lower.includes('kh ')) {
    return 'swap failed — execution provider error';
  }
  if (lower.includes('uniswap') || lower.includes('quote')) {
    return 'swap failed — no liquidity for this pair';
  }
  return 'swap failed';
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

// Hardcoded set of token addresses we expect on each supported chain.
// Mirrors the Router's TOKENS map but kept independent so the executor
// stays decoupled. Pseudo-ETH (0x000…000) is always valid.
const KNOWN_TOKENS: Record<string, string[]> = {
  mainnet: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
  ],
  base: [
    '0x4200000000000000000000000000000000000006',
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0xc3de830ea07524a0761646a6a4e4be0e114a3c83',
  ],
  unichain: [
    '0x4200000000000000000000000000000000000006',
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
    '0x078d782b760474a361dda0af3839290b0ef57ad6',
    '0x8f187aa05619a017077f5308904739877ce9ea21',
  ],
  sepolia: [
    '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
    '0x29f2d40b0605204364af54ec677bd022da425d03',
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
  ],
  'base-sepolia': [
    '0x4200000000000000000000000000000000000006',
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  ],
};

function isAddressOnChain(addr: string, chain: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '0x0000000000000000000000000000000000000000') return true;
  return (KNOWN_TOKENS[chain] ?? []).includes(lower);
}
