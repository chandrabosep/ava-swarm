/**
 * Cloudflare Worker — Zerion API proxy.
 *
 * Why it exists:
 *   - Zerion's API doesn't return permissive CORS headers, so the browser
 *     blocks responses to extension fetches.
 *   - We tried a Manifest V3 service worker proxy; @crxjs/vite-plugin's
 *     beta SW bundling has been unreliable.
 *   - A Cloudflare Worker is the path of least resistance: free tier covers
 *     dev usage, deploys in ~30 seconds, and lets us keep the API key off
 *     the client entirely.
 *
 * Deploy:
 *   npm install -g wrangler        # if you don't already have it
 *   wrangler login
 *   cd proxy
 *   wrangler deploy zerion-worker.js --name defi-swarm-zerion-proxy
 *   wrangler secret put ZERION_API_KEY   # paste your zk_... key
 *
 * Wrangler will print a URL like
 *   https://defi-swarm-zerion-proxy.<your-subdomain>.workers.dev
 *
 * Drop that URL into the extension's .env:
 *   VITE_ZERION_PROXY_URL=https://defi-swarm-zerion-proxy.<your-subdomain>.workers.dev
 *
 * After this, the extension never touches api.zerion.io directly and never
 * holds the API key.
 */

const ZERION_BASE = 'https://api.zerion.io/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // CORS preflight — let the browser through.
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return jsonError(405, 'Method not allowed', CORS_HEADERS);
    }

    const apiKey = env.ZERION_API_KEY;
    if (!apiKey) {
      return jsonError(
        500,
        'Worker is missing ZERION_API_KEY. Run: wrangler secret put ZERION_API_KEY',
        CORS_HEADERS,
      );
    }

    const incoming = new URL(request.url);
    // Forward path + query as-is. So /wallets/0x.../portfolio?currency=usd
    // on the proxy becomes /v1/wallets/0x.../portfolio?currency=usd on Zerion.
    const target = ZERION_BASE + incoming.pathname + incoming.search;

    const auth = 'Basic ' + btoa(apiKey + ':');
    const upstream = await fetch(target, {
      headers: { Authorization: auth, Accept: 'application/json' },
      // Cache GETs at the edge for 30s — drastically reduces hits on the
      // Zerion Demo plan when the same dashboard is open in multiple tabs.
      cf: { cacheTtl: 30, cacheEverything: true },
    });

    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    // Strip Cloudflare's set-cookie / cf-* headers that aren't useful to
    // an extension page and clutter DevTools.
    headers.delete('set-cookie');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};

function jsonError(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ errors: [{ title: message }] }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
