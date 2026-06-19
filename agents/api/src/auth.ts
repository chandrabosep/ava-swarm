// Wallet-signature auth for write endpoints.
//
// Threat: anything reachable on localhost:8787 (a rogue browser extension,
// another local process, a malicious tab whose extension whitelists this
// origin) can register sessions, mutate risk profiles, install skills,
// or hijack a victim's swarm by spoofing `walletAddress` in the body.
//
// Mitigation: writes require a fresh wallet signature.
//
//   Header: x-wallet-address  — lowercased EOA address claiming to act
//   Header: x-wallet-ts       — unix milliseconds (must be within ±5 min)
//   Header: x-wallet-sig      — personal_sign over the canonical message
//
// Canonical message:
//   `DefiSwarm AuthN v1\nWallet: 0x…\nTimestamp: <ts>`
//
// The address claimed in the header must equal the wallet field in the
// body / path that the request mutates — otherwise the signature would
// authorise actions on someone else's wallet.
//
// Behaviour gate: WALLET_AUTH_REQUIRED.
//   - `true`  (production)  → missing/invalid auth → 401.
//   - `false` (default)     → loud warning at boot; missing auth allowed
//     for backwards compatibility with the existing demo flow. Present
//     auth is still verified — a *bad* signature is always rejected.

import type { NextFunction, Request, Response } from 'express';
import { verifyMessage, type Address } from 'viem';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export const WALLET_AUTH_REQUIRED =
  (process.env.WALLET_AUTH_REQUIRED ?? '').toLowerCase() === 'true';

export function authCanonicalMessage(walletAddress: string, ts: number): string {
  return `DefiSwarm AuthN v1\nWallet: ${walletAddress.toLowerCase()}\nTimestamp: ${ts}`;
}

export interface VerifyResult {
  ok: boolean;
  /** Lowercased wallet address proven by the signature (only set on ok). */
  wallet?: string;
  /** Reason the verification failed, for logs. */
  reason?: string;
}

async function verifyHeaders(req: Request): Promise<VerifyResult> {
  const wallet = (req.header('x-wallet-address') ?? '').toLowerCase();
  const tsRaw = req.header('x-wallet-ts') ?? '';
  const sig = (req.header('x-wallet-sig') ?? '') as `0x${string}`;
  if (!wallet || !tsRaw || !sig) return { ok: false, reason: 'missing auth headers' };
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return { ok: false, reason: 'bad wallet format' };
  if (!/^0x[a-fA-F0-9]+$/.test(sig)) return { ok: false, reason: 'bad signature format' };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const skew = Math.abs(Date.now() - ts);
  if (skew > FIVE_MINUTES_MS) {
    return { ok: false, reason: `timestamp skew ${Math.round(skew / 1000)}s > 300s` };
  }
  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: wallet as Address,
      message: authCanonicalMessage(wallet, ts),
      signature: sig,
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'verify threw' };
  }
  if (!valid) return { ok: false, reason: 'signature does not recover to wallet' };
  return { ok: true, wallet };
}

/**
 * Express middleware: require a wallet signature whose claimed address
 * matches `extractWallet(req)`. When WALLET_AUTH_REQUIRED is false, missing
 * headers pass through (legacy mode); a *present* signature must still be
 * valid and match.
 */
export function requireWalletAuth(extractWallet: (req: Request) => string | undefined) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const expected = (extractWallet(req) ?? '').toLowerCase();
    const hasAnyHeader =
      req.header('x-wallet-address') ||
      req.header('x-wallet-ts') ||
      req.header('x-wallet-sig');

    if (!hasAnyHeader) {
      if (WALLET_AUTH_REQUIRED) {
        res.status(401).json({ error: 'wallet signature required' });
        return;
      }
      next();
      return;
    }

    const result = await verifyHeaders(req);
    if (!result.ok) {
      res.status(401).json({ error: `auth: ${result.reason}` });
      return;
    }
    if (expected && result.wallet !== expected) {
      res
        .status(403)
        .json({ error: `auth wallet ${result.wallet} ≠ target wallet ${expected}` });
      return;
    }
    next();
  };
}
