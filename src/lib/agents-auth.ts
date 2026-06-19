// Wallet-signature auth for agents-api calls.
//
// The backend (agents/api/src/auth.ts) requires writes to carry three
// headers proving ownership of the wallet they mutate:
//
//   x-wallet-address  — claimed EOA, lowercased
//   x-wallet-ts       — unix milliseconds (server tolerates ±5 min)
//   x-wallet-sig      — personal_sign over the canonical message
//
// Canonical message:
//   `DefiSwarm AuthN v1\nWallet: 0x…\nTimestamp: <ts>`
//
// We sign once per wallet and cache the signature for ~4 minutes so the
// user only sees the wallet popup at first activation and on refresh —
// not on every PUT /profile or PUT /config.
//
// The signer is registered by `useAuthSigner` (mounted at app root) so
// plain modules like `agents-api.ts` can pull headers without holding a
// React handle.

const FOUR_MINUTES_MS = 4 * 60 * 1000;

type Signer = (message: string) => Promise<`0x${string}`>;

let registeredSigner: Signer | null = null;
let registeredWallet: string | null = null;

interface CachedSig {
  ts: number;
  sig: string;
  wallet: string;
}
let cached: CachedSig | null = null;

export function registerAuthSigner(walletAddress: string, signer: Signer): void {
  registeredWallet = walletAddress.toLowerCase();
  registeredSigner = signer;
  // Drop cache if wallet changed.
  if (cached && cached.wallet !== registeredWallet) cached = null;
}

export function clearAuthSigner(): void {
  registeredWallet = null;
  registeredSigner = null;
  cached = null;
}

function authCanonicalMessage(walletAddress: string, ts: number): string {
  return `DefiSwarm AuthN v1\nWallet: ${walletAddress.toLowerCase()}\nTimestamp: ${ts}`;
}

/**
 * Get the headers needed to authenticate against the agents API. Returns
 * an empty object if no signer has registered yet (the request will go
 * through unsigned — the backend rejects it with 401 only when
 * WALLET_AUTH_REQUIRED=true on the server).
 *
 * Will pop the wallet on first call (and on refresh after the cache
 * window expires). Subsequent calls inside the window reuse the cached
 * signature — no popup.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (!registeredSigner || !registeredWallet) return {};
  const now = Date.now();
  if (cached && cached.wallet === registeredWallet && now - cached.ts < FOUR_MINUTES_MS) {
    return {
      'x-wallet-address': cached.wallet,
      'x-wallet-ts': String(cached.ts),
      'x-wallet-sig': cached.sig,
    };
  }
  const ts = now;
  const sig = await registeredSigner(authCanonicalMessage(registeredWallet, ts));
  cached = { ts, sig, wallet: registeredWallet };
  return {
    'x-wallet-address': registeredWallet,
    'x-wallet-ts': String(ts),
    'x-wallet-sig': sig,
  };
}
