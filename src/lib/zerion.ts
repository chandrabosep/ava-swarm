// Zerion API client — direct fetch through a CORS-permissive proxy.
//
// Configuration:
//   VITE_ZERION_PROXY_URL — required. URL of the Cloudflare Worker proxy
//     (see proxy/zerion-worker.js for source + deploy steps). The proxy
//     forwards requests to api.zerion.io, holds the API key server-side,
//     and adds Access-Control-Allow-Origin headers so the browser doesn't
//     block our fetches.
//
//   VITE_ZERION_API_KEY — optional fallback for direct calls (legacy path).
//     If a proxy URL is set the key is ignored on the client side; the
//     proxy holds it as a Cloudflare secret instead.
//
// Why a proxy and not a service worker? MV3 SWs bundled by
// @crxjs/vite-plugin@2.x-beta have proven unreliable — they register but
// never run, surfacing as "Receiving end does not exist" from the page.
// The proxy sidesteps the whole class of issues.

import type {
  ZerionFungibleResponse,
  ZerionPnlResponse,
  ZerionPortfolioResponse,
  ZerionPositionsResponse,
  ZerionTransactionsResponse,
} from '@/types/zerion';

const proxyUrl = import.meta.env.VITE_ZERION_PROXY_URL as string | undefined;
const apiKey = import.meta.env.VITE_ZERION_API_KEY as string | undefined;

if (!proxyUrl) {
  console.warn(
    '[zerion] VITE_ZERION_PROXY_URL is not set. Deploy proxy/zerion-worker.js to Cloudflare Workers and put the URL in .env. See proxy/zerion-worker.js for steps.',
  );
}

/** Strip trailing slash so we can concat path with leading slash safely. */
const BASE_URL = (proxyUrl ?? 'https://api.zerion.io/v1').replace(/\/$/, '');

export class ZerionError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    public url: string,
  ) {
    super(`Zerion ${status} ${statusText}: ${body || '(no body)'} — ${url}`);
    this.name = 'ZerionError';
  }
}

function authHeaders(): Record<string, string> {
  // If we have a proxy, the proxy holds the key — don't send it from here.
  if (proxyUrl) return {};
  if (!apiKey) return {};
  return { Authorization: `Basic ${btoa(`${apiKey}:`)}` };
}

async function zerionFetch<T>(
  path: string,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', ...authHeaders() },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZerionError(res.status, res.statusText, body, url.toString());
  }
  return (await res.json()) as T;
}

export interface PositionsQuery {
  /** Comma-separated chain ids (e.g. "ethereum,base,unichain"). */
  chainIds?: string;
  positions?: 'only_simple' | 'only_complex' | 'no_filter';
  trash?: 'only_trash' | 'only_non_trash' | 'no_filter';
  currency?: string;
  sort?: string;
}

export async function getFungiblePositions(
  address: string,
  query: PositionsQuery = {},
): Promise<ZerionPositionsResponse> {
  return zerionFetch<ZerionPositionsResponse>(
    `/wallets/${address.toLowerCase()}/positions/`,
    {
      currency: query.currency ?? 'usd',
      'filter[positions]': query.positions ?? 'only_simple',
      'filter[trash]': query.trash ?? 'only_non_trash',
      'filter[chain_ids]': query.chainIds,
      sort: query.sort ?? '-value',
    },
  );
}

export async function getWalletPortfolio(
  address: string,
  currency: string = 'usd',
): Promise<ZerionPortfolioResponse> {
  return zerionFetch<ZerionPortfolioResponse>(
    `/wallets/${address.toLowerCase()}/portfolio/`,
    { currency },
  );
}

export interface TransactionsQuery {
  pageSize?: number;
  chainIds?: string;
  operationTypes?: string;
  trash?: 'only_trash' | 'only_non_trash' | 'no_filter';
  currency?: string;
}

export async function getWalletTransactions(
  address: string,
  query: TransactionsQuery = {},
): Promise<ZerionTransactionsResponse> {
  return zerionFetch<ZerionTransactionsResponse>(
    `/wallets/${address.toLowerCase()}/transactions/`,
    {
      currency: query.currency ?? 'usd',
      'page[size]': String(query.pageSize ?? 10),
      'filter[trash]': query.trash ?? 'only_non_trash',
      'filter[chain_ids]': query.chainIds,
      'filter[operation_types]': query.operationTypes,
    },
  );
}

export async function getWalletPnl(
  address: string,
  currency: string = 'usd',
): Promise<ZerionPnlResponse> {
  return zerionFetch<ZerionPnlResponse>(
    `/wallets/${address.toLowerCase()}/pnl/`,
    { currency },
  );
}

export async function getFungible(id: string): Promise<ZerionFungibleResponse> {
  return zerionFetch<ZerionFungibleResponse>(`/fungibles/${id}`);
}
