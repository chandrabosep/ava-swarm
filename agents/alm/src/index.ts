// Active Liquidity Manager.
//
// Tick every minute: for each user with an active ALM session, read
// their Uniswap v4 positions, classify them (out-of-range / near-
// boundary / idle), and publish a RebalanceIntent for each drift.
//
// All onchain reads + heuristics live in ./positions.ts and ./strategy.ts;
// the per-tenant iterator + AXL publish live in ./tick.ts. This file
// just wires the boot sequence.

import { bootAgent, startHeartbeat, TOPICS } from '@swarm/shared';
import { startTick } from './tick.js';
import { startDebateListener } from './debate.js';

async function main() {
  const ctx = await bootAgent('alm');
  const stopHeartbeat = startHeartbeat(ctx);
  const stopTick = startTick(ctx);
  const stopDebate = startDebateListener(ctx);

  ctx.log.info('ready', {
    role: 'alm',
    publishes: [TOPICS.almRebalance, TOPICS.almFeedback],
    listens: [TOPICS.executorReceipt, TOPICS.heartbeat, TOPICS.pmDraft],
  });

  process.stdin.resume();
  void stopHeartbeat;
  void stopTick;
  void stopDebate;
}

main().catch((err: unknown) => {
  console.error('[alm:fatal]', err);
  process.exit(1);
});
