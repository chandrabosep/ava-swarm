// KeeperHub client — MCP-driven execution.
//
// We use KeeperHub's purpose-built MCP tools rather than the raw
// /api/execute/contract-call REST endpoint, because KH provides
// `search_protocol_actions` + `execute_protocol_action` specifically
// for DEX swaps (and other DeFi primitives). KH internally handles
// route-finding, calldata, msg.value, gas — the same problems we'd
// otherwise reinvent.
//
// Flow:
//   1. On first call, discover the Uniswap-swap action via
//      `search_protocol_actions`. Cache the action id.
//   2. For each swap intent, call `execute_protocol_action` with
//      tokenIn/tokenOut/amount/chain.
//   3. Poll `get_direct_execution_status` until terminal.
//
// Reference: https://docs.keeperhub.com/ai-tools

import { callKeeperhubTool } from './keeperhub-mcp.js';

// KeeperHub's `uniswap/swap-exact-input` action wants `network` as a
// chain id *string* (not a friendly name).
const NETWORK_CHAIN_ID = {
  mainnet: '1',
  base: '8453',
  unichain: '130',
} as const;

export type ChainName = keyof typeof NETWORK_CHAIN_ID;

// WETH addresses per chain — Uniswap V3 single-hop swaps don't accept
// native ETH, so we substitute WETH. The KeeperHub wallet must hold
// WETH (or have the wrap step happen elsewhere).
const WETH_ADDRESS: Record<ChainName, `0x${string}`> = {
  mainnet: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  unichain: '0x4200000000000000000000000000000000000006',
};

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/** Default V3 pool fee tier in hundredths-of-a-bip (3000 = 0.3%). */
const DEFAULT_POOL_FEE_BPS = '3000';

/** Uniswap V3 SwapRouter02 — same address on every chain we support. */
const UNISWAP_SWAP_ROUTER02 = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

const MAX_UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

const ERC20_APPROVE_ABI = JSON.stringify([
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
]);

let setupRan = false;

/**
 * One-time wallet setup: approve SwapRouter02 to spend WETH so
 * `uniswap/swap-exact-input` can pull tokens via transferFrom. Idempotent
 * (re-running just bumps the allowance to MAX). Skipped after first
 * success in this process — restart to re-run.
 */
export async function ensureKeeperhubSetup(chain: ChainName): Promise<void> {
  if (setupRan) return;
  if (process.env.KEEPERHUB_SKIP_SETUP === 'true') {
    setupRan = true;
    return;
  }
  console.log('[keeperhub] running one-time setup: approve SwapRouter02 for WETH');
  try {
    const raw = await callKeeperhubTool('execute_contract_call', {
      network: 'ethereum',
      contract_address: WETH_ADDRESS[chain],
      function_name: 'approve',
      function_args: JSON.stringify([UNISWAP_SWAP_ROUTER02, MAX_UINT256]),
      abi: ERC20_APPROVE_ABI,
      value: '0',
      gas_limit_multiplier: '1.5',
      integration_id: process.env.KEEPERHUB_INTEGRATION_ID,
    });
    const data = unwrapResult(raw) as {
      success?: boolean;
      executionId?: string;
      transactionHash?: string;
      error?: string;
    };
    if (data.success === false) {
      console.warn('[keeperhub] approve failed:', data.error);
    } else {
      console.log('[keeperhub] approve submitted:', data.executionId ?? data.transactionHash);
    }
  } catch (err) {
    console.warn(
      '[keeperhub] approve threw:',
      err instanceof Error ? err.message : String(err),
    );
  }
  setupRan = true;
}

export interface SubmitJobRequest {
  chain: ChainName;
  /** Universal Router address — informational; KH builds its own route. */
  to: `0x${string}`;
  /** Uniswap calldata — informational; we don't pass to KH's protocol-action. */
  data: `0x${string}`;
  /** Wei value — informational. */
  value: string;
  smartAccount: `0x${string}`;
  signature: `0x${string}`;
  metadata?: Record<string, unknown>;
  /** New: the actual swap parameters KH needs. */
  swap: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    /** Amount in tokenIn's smallest unit. */
    amountIn: string;
    /** Where to send the swapped output. */
    recipient: `0x${string}`;
  };
}

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'replaced' | 'mined';
  txHash?: `0x${string}`;
  blockNumber?: number;
  error?: string;
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function unwrapResult(res: unknown): unknown {
  const r = res as McpToolResult;
  if (r?.isError) {
    const text = r.content?.[0]?.text ?? 'unknown error';
    throw new Error(`KeeperHub MCP error: ${text}`);
  }
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const text = r?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

let cachedSwapActionId: string | null = null;

async function findUniswapSwapAction(): Promise<string> {
  if (cachedSwapActionId) return cachedSwapActionId;
  // Allow override so a known-good action id can be pinned in env.
  const override = process.env.KEEPERHUB_SWAP_ACTION_ID;
  if (override) {
    cachedSwapActionId = override;
    return override;
  }
  const raw = await callKeeperhubTool('search_protocol_actions', {
    query: 'uniswap swap',
  });
  const data = unwrapResult(raw);
  // Dump for debugging — KeeperHub's MCP response shape isn't documented.
  console.log(
    '[keeperhub] search_protocol_actions raw:',
    JSON.stringify(data).slice(0, 1500),
  );
  const list = extractActionList(data);
  const candidate =
    list.find(
      (a) =>
        /uniswap/i.test(stringField(a, 'name', 'protocol', 'title')) &&
        /swap/i.test(stringField(a, 'name', 'action', 'type')),
    ) ?? list[0];
  const id = idField(candidate);
  if (!id) {
    throw new Error(
      `KeeperHub: could not find a Uniswap swap action. Inspect the raw response logged above and set KEEPERHUB_SWAP_ACTION_ID. List size=${list.length}`,
    );
  }
  console.log('[keeperhub] picked swap action id:', id);
  cachedSwapActionId = id;
  return id;
}

function extractActionList(
  data: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return [];
  for (const key of [
    'actions',
    'results',
    'items',
    'data',
    'protocolActions',
  ]) {
    const v = d[key];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  return [];
}

function stringField(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return v;
  }
  return '';
}

function idField(obj: Record<string, unknown> | undefined): string | undefined {
  if (!obj) return undefined;
  for (const k of ['id', 'actionId', 'slug', 'key', 'identifier']) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export async function submitJob(
  req: SubmitJobRequest,
): Promise<{ jobId: string }> {
  await ensureKeeperhubSetup(req.chain);
  const actionType = await findUniswapSwapAction();

  // Uniswap V3 single-hop expects ERC-20 token addresses on both legs.
  // Native ETH (0x0) becomes WETH for the action's purposes; the KH
  // wallet is expected to hold WETH.
  const tokenIn =
    req.swap.tokenIn.toLowerCase() === NATIVE_ETH
      ? WETH_ADDRESS[req.chain]
      : req.swap.tokenIn;
  const tokenOut =
    req.swap.tokenOut.toLowerCase() === NATIVE_ETH
      ? WETH_ADDRESS[req.chain]
      : req.swap.tokenOut;

  const integrationId = process.env.KEEPERHUB_INTEGRATION_ID;

  const args: Record<string, unknown> = {
    actionType,
    integrationId,
    network: NETWORK_CHAIN_ID[req.chain],
    params: {
      network: NETWORK_CHAIN_ID[req.chain],
      tokenIn,
      tokenOut,
      fee: process.env.KEEPERHUB_POOL_FEE ?? DEFAULT_POOL_FEE_BPS,
      recipient: req.swap.recipient,
      amountIn: req.swap.amountIn,
      // Slippage handled at quote time; pass "0" to mean "accept any output".
      // Bump KEEPERHUB_MIN_OUT to enforce a floor.
      amountOutMinimum: process.env.KEEPERHUB_MIN_OUT ?? '0',
      // Docs mark this optional but the action validator rejects without
      // it. "0" = no price limit (accept the pool's current price).
      sqrtPriceLimitX96: '0',
      gasLimitMultiplier: '1.5',
    },
    metadata: req.metadata,
  };

  const raw = await callKeeperhubTool('execute_protocol_action', args);
  const data = unwrapResult(raw) as {
    success?: boolean;
    executionId?: string;
    jobId?: string;
    status?: string;
    transactionHash?: string;
    transactionLink?: string;
    error?: string;
  };

  if (data.success === false) {
    throw new Error(
      `KeeperHub: execute_protocol_action failed: ${data.error ?? 'unknown'}`,
    );
  }

  // KeeperHub's protocol-action runs synchronously and returns
  // `{ success: true, transactionHash, transactionLink, ... }`. Use the
  // tx hash as our jobId so the polling loop short-circuits with the
  // already-mined receipt.
  const jobId = data.executionId ?? data.jobId ?? data.transactionHash;
  if (!jobId) {
    throw new Error(
      `KeeperHub: no executionId or txHash in response. Raw: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  if (data.transactionHash) {
    console.log(
      `[keeperhub] swap landed: ${data.transactionLink ?? data.transactionHash}`,
    );
  }
  return { jobId };
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  // If submitJob already returned a txHash, the swap is mined — short-
  // circuit instead of asking KH for a status that won't exist.
  if (jobId.startsWith('0x') && jobId.length === 66) {
    return {
      jobId,
      status: 'mined',
      txHash: jobId as `0x${string}`,
    };
  }
  const raw = await callKeeperhubTool('get_direct_execution_status', {
    executionId: jobId,
  });
  const data = unwrapResult(raw) as {
    executionId?: string;
    status?: string;
    transactionHash?: string;
    error?: string | null;
  };
  const map: Record<string, JobStatus['status']> = {
    pending: 'pending',
    running: 'running',
    completed: 'mined',
    failed: 'failed',
  };
  return {
    jobId: data.executionId ?? jobId,
    status: map[data.status ?? ''] ?? (data.status as JobStatus['status']),
    txHash: data.transactionHash as `0x${string}` | undefined,
    error: data.error ?? undefined,
  };
}

export async function waitForJob(
  jobId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<JobStatus> {
  const { timeoutMs = 90_000, pollMs = 2_000 } = opts;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getJobStatus(jobId);
    if (
      status.status === 'mined' ||
      status.status === 'failed' ||
      status.status === 'replaced'
    ) {
      return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`KeeperHub job ${jobId} did not finalize within ${timeoutMs}ms`);
}
