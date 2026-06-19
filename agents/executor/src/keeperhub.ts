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
import {
  getErc20Allowance,
  getErc20Balance,
  getEthBalance,
  getKeeperhubWalletAddress,
  WETH_ADDRESS as WETH_ADDR,
  swapRouterFor,
  type ChainName as OnchainChainName,
} from './onchain.js';

// KeeperHub's `uniswap/swap-exact-input` action wants `network` as a
// chain id *string*. execute_contract_call / execute_transfer take a
// friendly network identifier instead — see KH_NETWORK_IDENT below.
const NETWORK_CHAIN_ID = {
  mainnet: '1',
  base: '8453',
  unichain: '130',
  sepolia: '11155111',
  'base-sepolia': '84532',
} as const;

export type ChainName = keyof typeof NETWORK_CHAIN_ID;

// Friendly network identifier KH expects in execute_contract_call /
// execute_transfer. Authoritative list from KH's own error message:
//   "Supported: mainnet, eth-mainnet, ethereum-mainnet, ethereum,
//    sepolia, eth-sepolia, sepolia-testnet,
//    base, base-mainnet, base-sepolia, base-testnet,
//    tempo-testnet, tempo, tempo-mainnet,
//    solana, solana-mainnet, solana-devnet, solana-testnet
//    or numeric chain IDs"
// Override with KH_NETWORK_<chain> if KH renames one.
const KH_NETWORK_IDENT: Record<ChainName, string> = {
  mainnet: process.env.KH_NETWORK_MAINNET ?? 'ethereum',
  base: process.env.KH_NETWORK_BASE ?? 'base',
  unichain: process.env.KH_NETWORK_UNICHAIN ?? 'unichain',
  sepolia: process.env.KH_NETWORK_SEPOLIA ?? 'sepolia',
  'base-sepolia': process.env.KH_NETWORK_BASE_SEPOLIA ?? 'base-testnet',
};

// WETH addresses per chain — Uniswap V3 single-hop swaps don't accept
// native ETH, so we substitute WETH. The KeeperHub wallet must hold
// WETH (or have the wrap step happen via WETH9.deposit() / fallback).
const WETH_ADDRESS: Record<ChainName, `0x${string}`> = {
  mainnet: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  unichain: '0x4200000000000000000000000000000000000006',
  sepolia: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  'base-sepolia': '0x4200000000000000000000000000000000000006',
};

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/** Default V3 pool fee tier in hundredths-of-a-bip (3000 = 0.3%). */
const DEFAULT_POOL_FEE_BPS = '3000';

/** Per-pair fee-tier preference list. Different pools live at different
 *  fee tiers on different chains. We try each in order until one works
 *  (or all fail, in which case we surface the original error). KH's
 *  /quote-then-execute flow accepts a `fee` param explicitly, so we
 *  control the pool selection.
 *
 *  Map keys are sorted token-pair strings ("LO|HI") so the lookup is
 *  direction-agnostic. Fee tier values are in hundredths-of-a-bip:
 *      100  = 0.01% (very stable pairs)
 *      500  = 0.05% (USDC/USDT, USDC/WETH on most chains)
 *     3000  = 0.3%  (default, most volatile pairs)
 *    10000  = 1%    (exotic / illiquid)
 */
const FEE_TIER_BY_PAIR_BY_CHAIN: Record<
  ChainName,
  Record<string, string[]>
> = {
  mainnet: {},
  base: {},
  unichain: {},
  // Sepolia liquidity is patchy: USDC pool lives at 0.05%, WBTC at 0.3%.
  sepolia: {
    // Both confirmed working onchain: 0x4cecfea8... (USDC@500) and
    // 0xe82b3c66... (WBTC@3000). Two-tier max so we don't sit through
    // 4 minutes of KH timeouts when a pool is just empty.
    [pairKey(
      '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    )]: ['500', '3000'], // WETH/USDC
    [pairKey(
      '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
      '0x29f2D40B0605204364af54EC677bD022dA425d03',
    )]: ['3000', '500'], // WETH/WBTC
  },
  'base-sepolia': {},
};

/** Build a sorted, lowercased "lo|hi" pair key. */
function pairKey(a: string, b: string): string {
  const lo = a.toLowerCase();
  const hi = b.toLowerCase();
  return lo < hi ? `${lo}|${hi}` : `${hi}|${lo}`;
}

/**
 * Per-KH-wallet mutex. Sepolia (and KH's sequencer) serialize
 * transactions from a single integration wallet anyway — running our
 * swap pipeline (wrap → approve → execute) concurrently for the same
 * wallet just races on WETH balance, allowance reads, and KH's nonce
 * picker. We serialize at the application layer so the runtime sees
 * a clean sequence: one wrap completes before the next swap reads
 * the WETH balance, allowance reads aren't stale, and KH never gets
 * two execute_protocol_action calls back-to-back from the same wallet.
 *
 * The mutex is keyed by wallet address (lowercased). If a future
 * iteration adds multi-wallet sponsorship, each wallet gets its own
 * lock.
 */
const walletLocks = new Map<string, Promise<void>>();

async function withWalletLock<T>(
  wallet: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = wallet.toLowerCase();
  const prev = walletLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  walletLocks.set(key, prev.then(() => next));
  try {
    await prev; // wait for the previous swap on this wallet to finish
    return await fn();
  } finally {
    release();
    // Clean up if nobody else queued behind us.
    if (walletLocks.get(key) === prev.then(() => next)) {
      walletLocks.delete(key);
    }
  }
}

/** Get the fee-tier ladder for a token pair on a chain. Falls back to
 *  the default tier if the pair isn't explicitly mapped. */
function feeTiersFor(
  chain: ChainName,
  tokenA: string,
  tokenB: string,
): string[] {
  const explicit = FEE_TIER_BY_PAIR_BY_CHAIN[chain]?.[pairKey(tokenA, tokenB)];
  if (explicit && explicit.length > 0) return explicit;
  // Env override applies to all unmapped pairs.
  const envOverride = process.env.KEEPERHUB_POOL_FEE;
  if (envOverride) return [envOverride];
  return [DEFAULT_POOL_FEE_BPS];
}

// SwapRouter02 address is now resolved per-chain via swapRouterFor().
// The hardcoded `0xE592...` constant was wrong — it's the legacy V3
// SwapRouter (V1), which doesn't exist on testnets.

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

// Threshold: if WETH allowance to SwapRouter02 falls below this, run an
// approve. Anything above this is treated as "already approved". Set to
// 1 ETH-equivalent — comfortable headroom for hundreds of demo swaps.
const ALLOWANCE_REFRESH_THRESHOLD = 10n ** 18n;

/**
 * Make sure SwapRouter02 has a usable allowance for `token` from the KH
 * wallet. Reads allowance via RPC and only fires `approve` when it's
 * actually below the threshold — most ticks are a no-op after the
 * first run. Works for any ERC-20, not just WETH (USDC→WBTC swaps
 * need USDC approved, etc).
 */
export async function ensureTokenApproved(
  chain: ChainName,
  token: `0x${string}`,
): Promise<void> {
  if (process.env.KEEPERHUB_SKIP_SETUP === 'true') return;
  const router = swapRouterFor(chain as OnchainChainName);
  try {
    const allowance = await getErc20Allowance(
      chain as OnchainChainName,
      token,
      router,
    );
    if (allowance >= ALLOWANCE_REFRESH_THRESHOLD) return; // already enough
    console.log(
      `[keeperhub] allowance(${token}→${router}) is ${allowance} (< threshold) — refreshing`,
    );
    const raw = await callKeeperhubTool('execute_contract_call', {
      network: KH_NETWORK_IDENT[chain],
      contract_address: token,
      function_name: 'approve',
      function_args: JSON.stringify([router, MAX_UINT256]),
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
      console.warn(`[keeperhub] approve(${token}) failed:`, data.error);
      return;
    }
    console.log(
      `[keeperhub] approve(${token}) submitted:`,
      data.executionId ?? data.transactionHash,
    );
    // Wait for the approve to actually mine before we let the caller
    // proceed to the swap — otherwise SwapRouter02's transferFrom will
    // see a still-zero allowance and revert with STF.
    await waitForKhExecution(data, `approve(${token})`, chain);
    // Re-read allowance to confirm it landed (RPCs sometimes lag a
    // block or two after KH says "completed").
    for (let i = 0; i < 10; i++) {
      const a = await getErc20Allowance(
        chain as OnchainChainName,
        token,
        router,
      );
      if (a >= ALLOWANCE_REFRESH_THRESHOLD) {
        console.log(`[keeperhub] approve(${token}) visible on chain`);
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    console.warn(
      `[keeperhub] approve(${token}) tx confirmed but allowance read still 0 — proceeding`,
    );
  } catch (err) {
    console.warn(
      '[keeperhub] approve threw:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Wait for a KH-submitted execution to terminate. Tries `transactionHash`
 * via RPC if present (fast path), falls back to polling
 * `get_direct_execution_status` via the MCP otherwise.
 */
async function waitForKhExecution(
  data: { executionId?: string; transactionHash?: string },
  label: string,
  chain: ChainName = 'mainnet',
): Promise<void> {
  if (data.transactionHash) {
    // Fast path: KH already returned a tx hash → wait for receipt.
    const { mainnet, sepolia, base, baseSepolia } = await import('viem/chains');
    const { createPublicClient, http } = await import('viem');
    const viemChain =
      chain === 'sepolia'
        ? sepolia
        : chain === 'base-sepolia'
          ? baseSepolia
          : chain === 'base'
            ? base
            : mainnet;
    const rpc =
      chain === 'sepolia'
        ? process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia.publicnode.com'
        : chain === 'base-sepolia'
          ? process.env.BASE_SEPOLIA_RPC_URL ?? 'https://base-sepolia.publicnode.com'
          : chain === 'base'
            ? process.env.BASE_RPC_URL ?? 'https://base.publicnode.com'
            : process.env.MAINNET_RPC_URL ?? 'https://ethereum.publicnode.com';
    const c = createPublicClient({
      chain: viemChain,
      transport: http(rpc),
    });
    try {
      await c.waitForTransactionReceipt({
        hash: data.transactionHash as `0x${string}`,
        timeout: 60_000,
      });
      console.log(`[keeperhub] ${label} mined: ${data.transactionHash}`);
      return;
    } catch (err) {
      console.warn(
        `[keeperhub] ${label} receipt wait failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  }
  if (data.executionId) {
    try {
      const final = await waitForJob(data.executionId, {
        timeoutMs: 60_000,
        pollMs: 1_500,
      });
      console.log(
        `[keeperhub] ${label} ${final.status}${final.txHash ? ` ${final.txHash}` : ''}`,
      );
    } catch (err) {
      console.warn(
        `[keeperhub] ${label} status poll failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Back-compat alias — older call sites pass a chain only and expect WETH. */
export async function ensureKeeperhubSetup(chain: ChainName): Promise<void> {
  return ensureTokenApproved(chain, WETH_ADDR[chain as OnchainChainName]);
}

/**
 * Top up WETH balance via WETH9.deposit() if the KH wallet doesn't hold
 * enough to cover this swap's amountIn. Wraps from native ETH; the
 * shortfall is computed against `amountIn` plus a small buffer to absorb
 * routing rounding.
 *
 * Only runs when tokenIn is WETH (the case Uniswap V3 single-hop swaps
 * always reduce to). For WETH→? swaps the KH wallet effectively becomes
 * a self-funding agent: the user deposits native ETH into the KH wallet
 * once, agents wrap-on-demand from then on.
 */
const WETH_DEPOSIT_ABI = JSON.stringify([
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
]);

export async function ensureWethBalance(
  chain: ChainName,
  amountInWei: bigint,
): Promise<void> {
  if (process.env.KEEPERHUB_SKIP_WRAP === 'true') return;
  const wallet = await getKeeperhubWalletAddress();
  const wethAddr = WETH_ADDR[chain as OnchainChainName];
  const wethBal = await getErc20Balance(chain as OnchainChainName, wethAddr);
  if (wethBal >= amountInWei) {
    return; // already enough
  }
  // Add 0.5% buffer so quote-time rounding doesn't push us under.
  const shortfall = amountInWei - wethBal;
  const wrapAmount = shortfall + shortfall / 200n;
  const ethBal = await getEthBalance(chain as OnchainChainName);
  // Reserve ETH for the gas of: this wrap (~30k gas) + the swap that
  // follows (~150-200k gas) + a possible approve (~50k gas). At 20 gwei
  // mainnet that's ~0.0005 ETH worst-case. Override with KH_GAS_RESERVE
  // (decimal ETH) to be more conservative for tight wallets.
  const gasReserve = process.env.KH_GAS_RESERVE
    ? BigInt(Math.floor(parseFloat(process.env.KH_GAS_RESERVE) * 1e18))
    : 500_000_000_000_000n; // 5e14 wei = 0.0005 ETH (~$1.50 at $3000/ETH)
  if (ethBal <= wrapAmount + gasReserve) {
    throw new Error(
      `KH wallet ${wallet} has insufficient native ETH to wrap. Have ${ethBal} wei, need ${
        wrapAmount + gasReserve
      } wei (${wrapAmount} to wrap + ${gasReserve} gas reserve). Fund the wallet with native ETH first.`,
    );
  }
  console.log(
    `[keeperhub] wrapping ${wrapAmount} wei ETH → WETH (have ${wethBal}, need ${amountInWei})`,
  );
  // KH's execute_contract_call silently drops a `value` field — verified
  // by inspect-tx showing wrap mined with value=0 (no-op). Use
  // execute_transfer instead: plain ETH transfer to the WETH9 contract
  // triggers its fallback function, which calls deposit() with the
  // received value — same effect, signed-by-the-integration-wallet.
  //
  // Field names per KH MCP validator: `recipient_address` and `amount`
  // (decimal ETH string, not wei). asset omitted = native ETH.
  const wrapAmountEth = (Number(wrapAmount) / 1e18).toFixed(18);
  const raw = await callKeeperhubTool('execute_transfer', {
    network: KH_NETWORK_IDENT[chain],
    recipient_address: wethAddr,
    amount: wrapAmountEth,
    integration_id: process.env.KEEPERHUB_INTEGRATION_ID,
  });
  const data = unwrapResult(raw) as {
    success?: boolean;
    executionId?: string;
    transactionHash?: string;
    error?: string;
  };
  if (data.success === false) {
    throw new Error(`KH wrap failed: ${data.error ?? 'unknown'}`);
  }
  console.log(
    '[keeperhub] wrap submitted:',
    data.transactionHash ?? data.executionId,
  );
  // Wait for the wrap to actually mine — otherwise the swap fires
  // before transferFrom can pull WETH and reverts with STF.
  await waitForKhExecution(data, 'wrap', chain);
  // Then poll the public RPC for the new balance to settle (1 block lag).
  for (let i = 0; i < 30; i++) {
    const bal = await getErc20Balance(chain as OnchainChainName, wethAddr);
    if (bal >= amountInWei) {
      console.log(`[keeperhub] wrap confirmed on chain: WETH balance now ${bal}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(
    '[keeperhub] wrap mined but balance read still lagging after 30s — proceeding anyway',
  );
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
  // Serialize all KH calls per wallet — see walletLocks doc above.
  // Sepolia + KH both serialize per-wallet anyway; doing it here means
  // ensureWethBalance, ensureTokenApproved, and execute_protocol_action
  // see consistent state on each invocation instead of racing.
  const lockWallet = await getKeeperhubWalletAddress();
  return withWalletLock(lockWallet, () => submitJobInner(req));
}

async function submitJobInner(
  req: SubmitJobRequest,
): Promise<{ jobId: string }> {
  // Uniswap V3 single-hop expects ERC-20 token addresses on both legs.
  // Native ETH (0x0) becomes WETH for the action's purposes; the KH
  // wallet either holds enough WETH or we wrap on-the-fly below.
  const tokenIn =
    req.swap.tokenIn.toLowerCase() === NATIVE_ETH
      ? WETH_ADDRESS[req.chain]
      : req.swap.tokenIn;
  const tokenOut =
    req.swap.tokenOut.toLowerCase() === NATIVE_ETH
      ? WETH_ADDRESS[req.chain]
      : req.swap.tokenOut;

  // Pre-flight: if the swap pulls WETH from the KH wallet, make sure
  // the wallet actually holds it. Wrap from native ETH if short. This
  // is what previously failed with Error(STF) on every tick once the
  // wallet's WETH was depleted.
  if (tokenIn.toLowerCase() === WETH_ADDRESS[req.chain].toLowerCase()) {
    await ensureWethBalance(req.chain, BigInt(req.swap.amountIn));
  } else {
    // Non-WETH tokenIn (e.g. USDC, WBTC) — the KH wallet must already
    // hold this token. There's no auto-bridge from the user's EOA in
    // this iteration. Surface a clear error instead of letting the
    // swap STF inside execute_protocol_action.
    const bal = await getErc20Balance(
      req.chain as OnchainChainName,
      tokenIn,
    );
    if (bal < BigInt(req.swap.amountIn)) {
      const wallet = await getKeeperhubWalletAddress();
      throw new Error(
        `KH wallet ${wallet} doesn't hold enough ${tokenIn}: balance ${bal} < amountIn ${req.swap.amountIn}. ` +
          `This swap requires the wallet to be funded with ${tokenIn} (no auto-bridge from EOA in this build).`,
      );
    }
  }
  // Approve whichever token the swap is pulling (WETH for ETH→*,
  // USDC for USDC→*, etc). One-time per token per wallet.
  await ensureTokenApproved(req.chain, tokenIn);

  // Diagnostic: log balance + allowance right before the swap so STF
  // errors are debuggable without reading the chain. If you see
  // `bal: 0` or `allowance: 0` here, you know exactly which precondition
  // failed before KH even called the router.
  const router = swapRouterFor(req.chain as OnchainChainName);
  {
    const wallet = await getKeeperhubWalletAddress();
    const bal = await getErc20Balance(req.chain as OnchainChainName, tokenIn);
    const allowance = await getErc20Allowance(
      req.chain as OnchainChainName,
      tokenIn,
      router,
    );
    console.log(
      `[keeperhub] pre-swap state wallet=${wallet} token=${tokenIn} bal=${bal} allowance=${allowance} amountIn=${req.swap.amountIn} router=${router}`,
    );
    // Hard-fail with a clear message before KH returns its opaque STF.
    if (bal < BigInt(req.swap.amountIn)) {
      throw new Error(
        `pre-swap: balance ${bal} < amountIn ${req.swap.amountIn} (token ${tokenIn} on ${req.chain}). ensureWethBalance/funding step did not land.`,
      );
    }
    if (allowance < BigInt(req.swap.amountIn)) {
      throw new Error(
        `pre-swap: allowance ${allowance} to ${router} < amountIn ${req.swap.amountIn}. ensureTokenApproved did not land — possibly approving the wrong router for this chain.`,
      );
    }
  }

  const actionType = await findUniswapSwapAction();
  const integrationId = process.env.KEEPERHUB_INTEGRATION_ID;

  // Walk the fee-tier ladder for this pair. Sepolia pools live at
  // different fee tiers per pair (USDC at 0.05%, WBTC at 0.3%, etc).
  // First tier that doesn't return a STF/no-pool error wins.
  const tiers = feeTiersFor(req.chain, tokenIn, tokenOut);
  let lastError = 'unknown';
  let data: {
    success?: boolean;
    executionId?: string;
    jobId?: string;
    status?: string;
    transactionHash?: string;
    transactionLink?: string;
    error?: string;
  } | null = null;

  for (const fee of tiers) {
    const args: Record<string, unknown> = {
      actionType,
      integrationId,
      network: NETWORK_CHAIN_ID[req.chain],
      params: {
        network: NETWORK_CHAIN_ID[req.chain],
        tokenIn,
        tokenOut,
        fee,
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

    console.log(`[keeperhub] trying fee tier ${fee} for ${tokenIn}->${tokenOut}`);
    const raw = await callKeeperhubTool('execute_protocol_action', args);
    data = unwrapResult(raw) as typeof data;

    if (data?.success === false) {
      lastError = data.error ?? 'unknown';
      console.log(
        `[keeperhub] fee tier ${fee} failed (${lastError.slice(0, 80)}), trying next...`,
      );
      // Only retry on errors that suggest "wrong pool" — STF, no pool,
      // insufficient liquidity. Other errors (insufficient balance,
      // bad params) won't be fixed by a different tier, fail fast.
      const retryable =
        /STF|no pool|insufficient liquidity|InsufficientLiquidity|Pool does not exist|reverted/i.test(
          lastError,
        );
      if (!retryable) break;
      continue;
    }
    // Got a non-error response — break out of the ladder.
    break;
  }

  if (!data || data.success === false) {
    throw new Error(
      `KeeperHub: execute_protocol_action failed across fee tiers ${tiers.join(',')}: ${lastError}`,
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
  // KH MCP naming inconsistency strikes again — this tool wants
  // `execution_id` (snake_case), unlike `get_wallet_integration` which
  // wants `integrationId` (camelCase). Verified against live tool's
  // Zod validation error.
  const raw = await callKeeperhubTool('get_direct_execution_status', {
    execution_id: jobId,
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
