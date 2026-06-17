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
  pm: '0x0000000000000000000000000000000000000000' as Address,
  /** Active Liquidity Manager — signs Uniswap v4 modifyLiquidity UserOps. */
  alm: '0x0000000000000000000000000000000000000000' as Address,
  /** Router — doesn't sign onchain. */
  router: '0x0000000000000000000000000000000000000000' as Address,
  /** Swap Executor — signs Universal Router UserOps via KeeperHub. */
  executor: '0x0000000000000000000000000000000000000000' as Address,
} as const;

export type SessionAgentRole = 'alm' | 'executor';
