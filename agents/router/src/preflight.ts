// Pre-flight check before Router dispatches a swap.
//
// Why this exists: PM/Router reason about the user's EOA portfolio,
// but the Executor swaps from the KH-managed wallet (different
// address, different balances) using Uniswap as the venue. Rather
// than let Executor reject swaps later (FAILED chip in the UI, noisy
// logs), we shape the swap list here to what's actually executable.
//
// Rules:
//   1. Drop swaps where KH has zero of the input token. Nothing to
//      sell, nothing to do.
//   2. Cap notionalUsd to KH's available USD balance of the input
//      token. If PM proposes selling $8455 of USDC but KH only has
//      $1.10 of USDC, we route a $1.10 swap instead of failing.
//   3. Drop tiny swaps below MIN_NOTIONAL_USD — execution gas + fees
//      eat them entirely.
//   4. Drop pairs the Uniswap Trading API doesn't have a quote for on
//      the target chain (Sepolia has no WBTC/UNI liquidity, Base
//      Sepolia has very little of anything). Probe with a tiny amount;
//      a 404 / ResourceNotFound means the executor would also fail.

import { fetchAlchemyTokens, alchemyBalanceFloat, alchemyUsdPrice, env } from '@swarm/shared';
import type { PairSwap } from './decompose.js';
import type { SupportedChain } from '@swarm/shared';

/** Skip routing for sub-$X swaps — gas + fees would eat them entirely. */
const MIN_NOTIONAL_USD = 0.5;

interface KhBalance {
  symbol: string;
  /** Whole-token balance (e.g. 1.5 ETH). */
  balance: number;
  /** USD price per whole token. */
  priceUsd: number;
  /** USD value at current price. */
  valueUsd: number;
}

/** Read the KH wallet's per-symbol balances on the chain Executor will
 *  swap on. Returns a map keyed by uppercased symbol. */
async function khBalances(
  khWallet: string,
): Promise<Map<string, KhBalance>> {
  const tokens = await fetchAlchemyTokens(khWallet.toLowerCase());
  const map = new Map<string, KhBalance>();
  for (const t of tokens) {
    if (t.error) continue;
    const rawSym = t.tokenMetadata?.symbol ?? '';
    const symbol = (
      t.tokenAddress === null && !rawSym ? 'ETH' : rawSym
    ).toUpperCase();
    if (!symbol) continue;
    const balance = alchemyBalanceFloat(t);
    const priceUsd = alchemyUsdPrice(t);
    const valueUsd = balance * priceUsd;
    if (valueUsd <= 0) continue;
    const cur = map.get(symbol);
    if (cur) {
      cur.balance += balance;
      cur.valueUsd += valueUsd;
      // Keep first-seen price as the canonical one; minor drift across
      // chains doesn't matter for capping.
    } else {
      map.set(symbol, { symbol, balance, priceUsd, valueUsd });
    }
  }
  return map;
}

export interface PreflightResult {
  /** Swaps that survived KH-balance and minimum-notional checks. May be
   *  resized down from the input. */
  swaps: PairSwap[];
  /** Swaps that were dropped, with reason. For logging. */
  dropped: Array<{ swap: PairSwap; reason: string }>;
}

/**
 * Filter and resize swaps based on what the KH wallet can actually do.
 *
 * Hard-fails when `KEEPERHUB_WALLET_ADDRESS` is unset — previously this
 * fell open, which lets oversized or unfunded swaps through to KH where
 * they fail with opaque errors and (worst case) drain ETH on retries.
 * If you genuinely don't want preflight, set `ROUTER_PREFLIGHT=false`
 * instead — that's an explicit opt-out, not a silent misconfig.
 */
export async function preflightSwaps(
  swaps: PairSwap[],
  log?: ProbeLogger,
): Promise<PreflightResult> {
  const khWallet = process.env.KEEPERHUB_WALLET_ADDRESS;
  if (!khWallet) {
    throw new Error(
      'preflightSwaps: KEEPERHUB_WALLET_ADDRESS is not set. Either set it ' +
        'in agents/.env or disable preflight with ROUTER_PREFLIGHT=false.',
    );
  }

  const balances = await khBalances(khWallet);

  const dropped: PreflightResult['dropped'] = [];

  // ---- pass 1: KH balance check + size cap ------------------------------
  const balanceFiltered: PairSwap[] = [];
  for (const swap of swaps) {
    const inSym = swap.tokenInSymbol.toUpperCase();
    const bal = balances.get(inSym);

    if (!bal || bal.valueUsd <= 0) {
      dropped.push({
        swap,
        reason: `KH wallet has 0 ${inSym} (needs $${swap.notionalUsd.toFixed(2)})`,
      });
      continue;
    }

    // Cap to what KH actually has — leave 5% headroom for gas / rounding
    // so we don't try to swap exactly the balance and fail on dust.
    const usableUsd = bal.valueUsd * 0.95;
    let notionalUsd = swap.notionalUsd;
    if (notionalUsd > usableUsd) {
      notionalUsd = usableUsd;
    }
    if (notionalUsd < MIN_NOTIONAL_USD) {
      dropped.push({
        swap,
        reason: `swap < $${MIN_NOTIONAL_USD} after KH-balance cap (KH has $${bal.valueUsd.toFixed(2)} of ${inSym})`,
      });
      continue;
    }

    balanceFiltered.push({ ...swap, notionalUsd });
  }

  // ---- pass 2: Uniswap quote liveness probe ------------------------------
  // Probe with the swap's *actual* size — dust-size probes return false
  // positives on Sepolia (Uniswap successfully routes 0.001 USDC then
  // 404s at $20). Probes run in parallel; the per-(chain, in, out, size-bucket)
  // cache collapses duplicate pairs.
  const probeCache = new Map<string, boolean>();
  const out: PairSwap[] = [];
  const probeResults = await Promise.all(
    balanceFiltered.map((swap) => {
      const amountIn = notionalToAmountIn(
        swap.notionalUsd,
        swap.tokenInPriceUsd,
        swap.tokenInDecimals,
      );
      return probeUniswap(
        swap.chain as SupportedChain,
        swap.tokenIn,
        swap.tokenOut,
        amountIn,
        khWallet as `0x${string}`,
        probeCache,
        log,
      ).then((alive) => ({ swap, alive }));
    }),
  );
  for (const { swap, alive } of probeResults) {
    if (!alive) {
      dropped.push({
        swap,
        reason: `Uniswap has no quotes for ${swap.tokenInSymbol}->${swap.tokenOutSymbol} on ${swap.chain} at $${swap.notionalUsd.toFixed(2)}`,
      });
      continue;
    }
    out.push(swap);
  }

  return { swaps: out, dropped };
}

/** Whether preflight is enabled. Defaults on under USE_TESTNET because
 *  testnet KH wallets are usually faucet-funded and small; mainnet
 *  setups typically have well-funded KH wallets and don't need it. */
export function preflightEnabled(): boolean {
  const explicit = process.env.ROUTER_PREFLIGHT;
  if (explicit !== undefined) return explicit.toLowerCase() === 'true';
  return env.useTestnet();
}

// =====================================================================
// Uniswap quote probe — drop pairs the Trading API has no liquidity for
// =====================================================================
//
// We POST /quote with a tiny amount and treat the call as "live" if it
// returns 2xx, "dead" if the body matches Uniswap's `ResourceNotFound`
// shape. Other errors (rate limits, 5xx) → fail open; let the executor
// try in case it was a transient hiccup.

const CHAIN_ID: Record<string, number> = {
  mainnet: 1,
  base: 8453,
  unichain: 130,
  sepolia: 11155111,
  'base-sepolia': 84532,
  'unichain-sepolia': 1301,
};

/** Probe Uniswap's Trading API for a single pair. Returns false only if
 *  Uniswap explicitly says "no quotes available". Caches per pair so a
 *  three-pair allocation hits Uniswap at most three times.
 *
 *  Uses a realistic amountIn (the swap's actual size) because Uniswap's
 *  Sepolia routing returns success for some pair+dust combos and 404
 *  for the same pair at production sizes. Dust-size probes generated
 *  false positives. */
interface ProbeLogger {
  (msg: string, meta?: Record<string, unknown>): void;
}

async function probeUniswap(
  chain: SupportedChain,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: string,
  swapper: `0x${string}`,
  cache: Map<string, boolean>,
  log?: ProbeLogger,
): Promise<boolean> {
  // Cache by (chain, in, out, amount-bucket). Bucket the amount to the
  // nearest power of 10 so $20 and $25 share a probe but $20 and $2000
  // don't (Uniswap routing can differ across order of magnitude).
  const bucket = String(amountIn).length;
  const key = `${chain}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}|${bucket}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const baseUrl =
    process.env.UNISWAP_API_BASE ?? 'https://trade-api.gateway.uniswap.org/v1';
  const apiKey = process.env.UNISWAP_API_KEY ?? '';

  // Mirror the executor's exact request shape — divergence here is what
  // produces the "probe says alive, executor 404s" mystery.
  const reqBody = {
    type: 'EXACT_INPUT',
    tokenIn,
    tokenOut,
    tokenInChainId: CHAIN_ID[chain],
    tokenOutChainId: CHAIN_ID[chain],
    amount: amountIn,
    swapper,
    slippageTolerance: 5,
  };

  let alive = true; // fail open by default
  let probeStatus: number | string = 'unknown';
  let probeBody = '';

  try {
    const res = await fetch(`${baseUrl}/quote`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(reqBody),
    });
    probeStatus = res.status;
    probeBody = await res.text().catch(() => '');
    if (res.ok) {
      alive = true;
    } else if (res.status === 404 && probeBody.includes('ResourceNotFound')) {
      alive = false;
    } else {
      // 4xx (auth, rate limit) / 5xx — be conservative and treat as
      // "we're not sure", drop the swap. Better to skip a borderline
      // pair than emit a routed intent that will FAIL downstream.
      alive = false;
    }
  } catch (err) {
    probeStatus = err instanceof Error ? err.message : 'network error';
    // Network error — keep failing open here so a flaky outbound link
    // doesn't block all routing. Logged below for visibility.
    alive = true;
  }

  log?.(`uniswap probe ${alive ? 'alive' : 'DEAD'}`, {
    pair: `${tokenIn.slice(0, 10)}->${tokenOut.slice(0, 10)}`,
    chain,
    amountIn,
    status: probeStatus,
    snippet: probeBody.slice(0, 160),
    apiKeyPresent: apiKey.length > 0,
  });

  cache.set(key, alive);
  return alive;
}

/** Convert USD notional → tokenIn base units, mirroring dispatch.ts. */
function notionalToAmountIn(
  notionalUsd: number,
  priceUsd: number,
  decimals: number,
): string {
  const tokens = notionalUsd / Math.max(priceUsd, 0.0001);
  const raw = BigInt(Math.floor(tokens * Math.pow(10, decimals)));
  return raw.toString();
}
