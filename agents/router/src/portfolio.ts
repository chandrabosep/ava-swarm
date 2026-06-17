// Same Zerion-snapshot helper PM uses, narrowed to what Router needs:
// the user's current per-symbol USD holdings. Duplicated here (rather
// than importing from PM) because Router and PM live in separate npm
// workspaces and we don't want a cross-agent runtime dep.

import { env } from '@swarm/shared';
import type { Symbol } from './tokens.js';
import type { CurrentSlice } from './decompose.js';

interface ZerionPositionsResponse {
  data: Array<{
    attributes: {
      value: number | null;
      fungible_info: { symbol: string };
    };
  }>;
}

const ALLOWED: Symbol[] = ['ETH', 'WETH', 'WBTC', 'USDC', 'UNI'];

export async function currentSlices(safe: string): Promise<CurrentSlice[]> {
  const url = `${env.zerionProxyUrl()}/wallets/${safe.toLowerCase()}/positions/?currency=usd&filter[positions]=only_simple&filter[trash]=only_non_trash&sort=-value`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zerion ${res.status}`);
  const json = (await res.json()) as ZerionPositionsResponse;
  // Aggregate by symbol — Zerion can return same symbol on multiple chains
  // and we treat them as fungible at the allocation layer.
  const map = new Map<Symbol, number>();
  for (const p of json.data) {
    const sym = p.attributes.fungible_info.symbol as Symbol;
    if (!ALLOWED.includes(sym)) continue;
    const value = p.attributes.value ?? 0;
    map.set(sym, (map.get(sym) ?? 0) + value);
  }
  return Array.from(map.entries()).map(([symbol, valueUsd]) => ({
    symbol,
    valueUsd,
  }));
}
