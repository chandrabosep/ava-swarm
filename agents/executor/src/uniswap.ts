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
  const slippageBps = req.slippageBps ?? 50;
  const raw = await uni<{
    quote: Record<string, unknown>;
    methodParameters?: { calldata: string; value: string; to: string };
  }>('/quote', {
    type: 'EXACT_INPUT',
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    tokenInChainId: CHAIN_ID[req.chain],
    tokenOutChainId: CHAIN_ID[req.chain],
    amount: req.amountIn,
    swapper: req.swapper,
    slippageTolerance: slippageBps / 100,
  });

  // The API has shipped two response shapes — older one nests
  // methodParameters inside `quote`, newer one puts it at the root. We
  // accept either to keep this resilient across deploys.
  const q = raw.quote as Record<string, unknown> & {
    methodParameters?: { calldata: string; value: string; to: string };
  };
  const m = raw.methodParameters ?? q.methodParameters;

  if (!m) {
    throw new Error(
      'Uniswap /quote returned no methodParameters — is the swapper address correct + has it approved Permit2?',
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
    raw,
  };
}
