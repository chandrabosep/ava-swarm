// Swarm pub/sub topic names.
//
// Channel names for inter-agent messages, carried over the Postgres
// LISTEN/NOTIFY mesh (see mesh.ts + pg-gossip.ts). Previously these doubled
// as AXL gossip topics; AXL has been removed — single-host Postgres gossip
// plus the always-on DB-poll fallback (intent-poll.ts) carry everything.

import type { AgentRole } from './db.js';

export const TOPICS = {
  pmAllocation: 'swarm.pm.allocation',
  almRebalance: 'swarm.alm.rebalance',
  routerRouted: 'swarm.router.routed',
  executorReceipt: 'swarm.executor.receipt',
  heartbeat: 'swarm.heartbeat',
  otcAdvertise: 'swarm.otc.advertise',
  otcConfirm: 'swarm.otc.confirm',
  // Debate protocol — PM publishes a draft proposal, peer agents weigh
  // in with concerns, PM reconciles, then publishes the final
  // allocation on pmAllocation. Real consensus mechanic.
  // See agents/pm/src/debate.ts.
  pmDraft: 'swarm.pm.draft',
  almFeedback: 'swarm.alm.feedback',
  routerFeedback: 'swarm.router.feedback',
} as const;

export type { AgentRole };
