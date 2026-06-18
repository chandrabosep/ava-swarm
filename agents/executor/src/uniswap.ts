// Uniswap Trading API client.
//
// One call: POST /quote returns the route, prices, AND the
// methodParameters object holding Universal Router calldata. We don't
// need a separate /swap call — we wrap everything in `quote()` and
// hand back what Executor needs to sign + submit.
//
// Auth: x-api-key header (key from https://developers.uniswap.org).
// Reference: https://docs.uniswap.org/api/uniswap-x/overview

import { env } from '@swarm/shared';

// Chain IDs for the Uniswap Trading API's `tokenInChainId` /
// `tokenOutChainId` fields. Per the docs, the API supports the testnets
// listed below — we just need to actually pass the IDs.
//   https://docs.uniswap.org/api/uniswap-x/supported-chains-and-tokens
const CHAIN_ID = {
  mainnet: 1,
  base: 8453,
  unichain: 130,
  sepolia: 11155111,
  'base-sepolia': 84532,
  'unichain-sepolia': 1301,
} as const;
export type ChainName = keyof typeof CHAIN_ID;

export interface QuoteRequest {
  chain: ChainName;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  /** base-unit string. */
  amountIn: string;
  /** Address that will execute the swap. Must hold the input token. */
  swapper: `0x${string}`;
  /** Where the output token lands. Defaults to the swapper. */
  recipient?: `0x${string}`;
  /** Slippage in bps (50 = 0.5%). Defaults to 50. */
  slippageBps?: number;
}

export interface Quote {
  /** Universal Router on the target chain. */
  to: `0x${string}`;
  /** Calldata to send. */
  data: `0x${string}`;
  /** Wei value to attach. "0" for ERC-20 → ERC-20. */
  value: string;
  amountIn: string;
  amountOut: string;
  amountOutMinimum: string;
  /** USD-denominated price impact, if Uniswap returned one. */
  priceImpactUsd?: number;
  /** Estimated gas in units (string). */
  gasEstimate?: string;
  /** Underlying response, kept for debugging. */
  raw: unknown;
}

async function uni<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.uniswapBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.uniswapApiKey(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Uniswap ${path} ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function quote(req: QuoteRequest): Promise<Quote> {
  // Larger default slippage so tiny demo swaps (~$1) don't revert at the
  // router's slippage check — gas + impact at micro size easily exceeds
  // the typical 0.5% buffer.
  const slippageBps = req.slippageBps ?? 500;

  // Step 1: /quote — returns the route + amounts. Modern API doesn't
  // include methodParameters here; we have to follow up with /swap.
  const quoteRes = await uni<{
    quote: Record<string, unknown>;
    routing?: string;
    permitData?: unknown;
    methodParameters?: { calldata: string; value: string; to: string };
  }>('/quote', {
    type: 'EXACT_INPUT',
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    tokenInChainId: CHAIN_ID[req.chain],
    tokenOutChainId: CHAIN_ID[req.chain],
    amount: req.amountIn,
    swapper: req.swapper,
    ...(req.recipient ? { recipient: req.recipient } : {}),
    slippageTolerance: slippageBps / 100,
  });

  const q = quoteRes.quote as Record<string, unknown> & {
    methodParameters?: { calldata: string; value: string; to: string };
  };

  // Some legacy deployments still nest methodParameters in the quote
  // body. Use those when present.
  let m = quoteRes.methodParameters ?? q.methodParameters;

  // Step 2: /swap — pass the quote response back, get methodParameters.
  // Required for newer Trading API responses where /quote skips the
  // calldata so a permit signing round-trip can happen in between for
  // ERC-20 inputs. Native-ETH swaps (permitData: null) skip the sign
  // step but still need this /swap call.
  if (!m) {
    const swapRes = await uni<{
      swap?: { to: string; from: string; data: string; value: string };
      methodParameters?: { calldata: string; value: string; to: string };
    }>('/swap', {
      quote: quoteRes.quote,
      // Optional permit signature would go here for ERC-20 inputs that
      // had a permitData payload. ETH input has permitData=null so we
      // skip it.
    });

    if (swapRes.swap) {
      m = {
        to: swapRes.swap.to,
        calldata: swapRes.swap.data,
        value: swapRes.swap.value ?? '0',
      };
    } else if (swapRes.methodParameters) {
      m = swapRes.methodParameters;
    }
  }

  if (!m) {
    const summary = JSON.stringify(quoteRes).slice(0, 600);
    throw new Error(
      `Uniswap /swap also returned no methodParameters. Quote was: ${summary}`,
    );
  }

  return {
    to: m.to as `0x${string}`,
    data: m.calldata as `0x${string}`,
    value: m.value ?? '0',
    amountIn: String(q.amountIn ?? req.amountIn),
    amountOut: String(q.amountOut ?? '0'),
    amountOutMinimum: String(q.amountOutMinimum ?? '0'),
    priceImpactUsd:
      typeof q.priceImpactUsd === 'number' ? q.priceImpactUsd : undefined,
    gasEstimate:
      typeof q.gasUseEstimate === 'string' ? q.gasUseEstimate : undefined,
    raw: quoteRes,
  };
}
