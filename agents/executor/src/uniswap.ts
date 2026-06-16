// Uniswap Trading API client.
//
// We use the hosted Trading API rather than building Universal Router
// calldata by hand. Two endpoints matter for Executor:
//   POST /quote   — returns a route + price + minimum out
//   POST /swap    — returns calldata ready to send to Universal Router
//
// Auth: x-api-key header. Get a key at https://developers.uniswap.org.
//
// Reference: https://docs.uniswap.org/api/uniswap-x/overview (the /quote
// + /swap shape is shared across the unified Trading API surface).

import { env } from '@swarm/shared';

const CHAIN_ID = { mainnet: 1, base: 8453, unichain: 130 } as const;

export type ChainName = keyof typeof CHAIN_ID;

export interface QuoteRequest {
  chain: ChainName;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  /** base-unit string. */
  amountIn: string;
  /** Recipient — typically the Safe address. */
  swapper: `0x${string}`;
  /** Fraction (0.5 = 0.5%). Defaults to 0.5%. */
  slippageBps?: number;
}

export interface QuoteResponse {
  /** quoteId echoed into /swap so the API can recover routing context. */
  quoteId: string;
  amountIn: string;
  amountOut: string;
  amountOutMinimum: string;
  /** Estimated USD value of the swap, used for cap checks before submit. */
  notionalUsd?: number;
  /** Underlying response, kept for debugging — no app code reads this. */
  raw: unknown;
}

export interface SwapResponse {
  /** Where to send the calldata — Universal Router on the target chain. */
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  gasUseEstimate?: string;
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

export async function getQuote(req: QuoteRequest): Promise<QuoteResponse> {
  const slippageBps = req.slippageBps ?? 50;
  const raw = await uni<{ quote: Record<string, unknown> }>('/quote', {
    type: 'EXACT_INPUT',
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    tokenInChainId: CHAIN_ID[req.chain],
    tokenOutChainId: CHAIN_ID[req.chain],
    amount: req.amountIn,
    swapper: req.swapper,
    slippageTolerance: slippageBps / 100,
  });
  const q = raw.quote;
  return {
    quoteId: String(q.quoteId ?? q.requestId ?? ''),
    amountIn: String(q.amountIn ?? req.amountIn),
    amountOut: String(q.amountOut ?? '0'),
    amountOutMinimum: String(q.amountOutMinimum ?? '0'),
    notionalUsd:
      typeof q.gasUseEstimateUSD === 'number' ? undefined : undefined,
    raw,
  };
}

export async function buildSwap(quote: QuoteResponse): Promise<SwapResponse> {
  const raw = await uni<{ swap: Record<string, unknown> }>('/swap', {
    quote: quote.raw,
  });
  const s = raw.swap;
  return {
    to: s.to as `0x${string}`,
    data: s.data as `0x${string}`,
    value: String(s.value ?? '0'),
    gasUseEstimate:
      typeof s.gasUseEstimate === 'string' ? s.gasUseEstimate : undefined,
    raw,
  };
}
