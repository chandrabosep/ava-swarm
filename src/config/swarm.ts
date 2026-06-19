// Service addresses for the agent swarm — Model B.
//
// Each agent runs as a backend service holding ONE fixed keypair. The
// extension grants the user's Safe to these addresses via Smart Sessions.
// All users grant to the same addresses — multi-tenancy lives in the
// per-user policies stored in the Smart Sessions module, not in
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
