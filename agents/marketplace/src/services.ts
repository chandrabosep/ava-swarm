// The "work" each specialist sells. Lightweight + deterministic by design —
// per the Speedrun's "start small" guidance, the demo's value is the autonomous
// x402 payment + ERC-8004 reputation loop, not analytics fidelity. Each
// function turns a job input into a plausible result with no external calls.

import { createHash } from 'node:crypto';

/** Stable pseudo-number in [0,1) derived from arbitrary inputs. */
function seed(...parts: Array<string | number>): number {
  const h = createHash('sha256').update(parts.join('|')).digest();
  // First 6 bytes → integer → normalize.
  const n = h.readUIntBE(0, 6);
  return n / 0xffffffffffff;
}

export interface QuoteInput {
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: number;
}

export function quoteRoute(input: QuoteInput) {
  const tokenIn = (input.tokenIn ?? 'USDC').toUpperCase();
  const tokenOut = (input.tokenOut ?? 'WAVAX').toUpperCase();
  const amountIn = Number(input.amountIn ?? 100);
  const r = seed('route', tokenIn, tokenOut, amountIn);
  const venues = ['lfj-v2', 'pangolin', 'lfj-v1'];
  const venue = venues[Math.floor(r * venues.length)];
  const priceImpactBps = Math.round(5 + r * 80); // 5..85 bps
  const hops = r > 0.7 ? 2 : 1;
  // Synthetic exchange rate around 1 unit in → ~24 units out for USDC→WAVAX.
  const rate = 0.04 + seed('rate', tokenIn, tokenOut) * 0.02;
  const amountOut = Number((amountIn / rate).toFixed(4));
  return {
    service: 'quote-route',
    tokenIn,
    tokenOut,
    amountIn,
    venue,
    hops,
    amountOut,
    priceImpactBps,
  };
}

export interface RiskInput {
  token?: string;
  amountUsd?: number;
}

export function riskCheck(input: RiskInput) {
  const token = (input.token ?? 'WAVAX').toUpperCase();
  const amountUsd = Number(input.amountUsd ?? 100);
  const r = seed('risk', token, amountUsd);
  const flags: string[] = [];
  if (amountUsd > 1000) flags.push('size>1k');
  if (r > 0.85) flags.push('thin-liquidity');
  if (r < 0.1) flags.push('new-pool');
  // Lower score = safer.
  const riskScore = Math.round(r * 100);
  const verdict = riskScore < 40 ? 'ok' : riskScore < 75 ? 'caution' : 'high-risk';
  return { service: 'risk-check', token, amountUsd, riskScore, verdict, flags };
}

export interface PriceInput {
  token?: string;
}

export function priceData(input: PriceInput) {
  const token = (input.token ?? 'AVAX').toUpperCase();
  const r = seed('price', token);
  const priceUsd = Number((1 + r * 80).toFixed(4));
  const change24hPct = Number(((seed('chg', token) - 0.5) * 20).toFixed(2));
  const sentiment = change24hPct > 3 ? 'bullish' : change24hPct < -3 ? 'bearish' : 'neutral';
  return { service: 'price', token, priceUsd, change24hPct, sentiment };
}
