// Service addresses for the agent swarm — Model B.
//
// Each agent runs as a backend service holding ONE fixed keypair. The
// extension grants the user's EOA delegation to these addresses via
// EIP-7702. All users grant to the same addresses — multi-tenancy lives
// in the per-user policies stored alongside the delegation, not in
// per-user keypairs.
//
// To deploy your own swarm:
//   1. Generate four privkeys (`openssl rand -hex 32` x4).
//   2. Put them in agents/.env (PM_/ALM_/ROUTER_/EXECUTOR_SERVICE_PRIVKEY).
//   3. Boot any agent — it logs its derived service address at startup.
//   4. Paste the addresses below.
//
// The extension reads only the public addresses; privkeys never leave
// the agent servers.

import type { Address } from 'viem';

export const SWARM_SERVICE_ADDRESSES = {
  /** Portfolio Manager — doesn't actually sign onchain in Phase A/B-1. */
  pm: '0xAe3dafa9d6E68f1651f4AC709B907F66252D7Fc1' as Address,
  /** Active Liquidity Manager — signs Uniswap v4 modifyLiquidity UserOps. */
  alm: '0xed7dfbDb2787a28F7386ed6a86e9bfcF83266109' as Address,
  /** Router — doesn't sign onchain. */
  router: '0x7A8a58cbE22d40Bc01CEEbD9a4B374D0fda666F3' as Address,
  /** Swap Executor — signs Universal Router UserOps via KeeperHub. */
  executor: '0x7D7627c2570a578A72c4AFBCd4EcF03a2526d67c' as Address,
} as const;

export type SessionAgentRole = 'alm' | 'executor';

/**
 * Where the extension reports newly-granted Smart Sessions so the agents'
 * Postgres has a Session row to look up next tick.
 *
 * Override at build time with `VITE_AGENTS_API_URL` (e.g. point to your
 * deployed agents host). Default is local dev.
 */
export const AGENTS_API_URL =
  (import.meta.env.VITE_AGENTS_API_URL as string | undefined) ??
  'http://localhost:8787';

/**
 * When true, the dashboard runs in testnet mode:
 *   - wallet connect offers Sepolia / Base Sepolia
 *   - portfolio is read from Alchemy (Zerion doesn't index testnets)
 *   - explorer links go to sepolia.etherscan.io / sepolia.basescan.org
 *
 * Toggle via VITE_USE_TESTNET=true in `.env.local`. Mirrors the agents'
 * USE_TESTNET env so a single flag flips both halves of the stack.
 */
export const USE_TESTNET =
  String(import.meta.env.VITE_USE_TESTNET ?? '').toLowerCase() === 'true';

/**
 * Alchemy API key — used for browser-side portfolio reads when
 * USE_TESTNET is on. Falls back to the public docs-demo key (rate-
 * limited) if VITE_ALCHEMY_API_KEY isn't set.
 */
export const ALCHEMY_API_KEY =
  (import.meta.env.VITE_ALCHEMY_API_KEY as string | undefined) ??
  'docs-demo';

/**
 * Comma-separated Alchemy network identifiers used for testnet portfolio
 * reads. Defaults to Sepolia + Base Sepolia.
 */
export const ALCHEMY_NETWORKS = (
  (import.meta.env.VITE_ALCHEMY_NETWORKS as string | undefined) ??
  'eth-sepolia,base-sepolia'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
