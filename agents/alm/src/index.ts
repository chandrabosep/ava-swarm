// Active Liquidity Manager.
//
// Watches each user's Uniswap v4 LP positions on a tick. When a position
// drifts out of its optimal range or inventory shifts past a threshold,
// publishes a RebalanceIntent on AXL for the Router.
//
// This commit boots + heartbeats. v4 SDK integration lands in commit 4.

import { bootAgent, startHeartbeat, TOPICS } from '@swarm/shared';

async function main() {
  const ctx = await bootAgent('alm');
  const stopHeartbeat = startHeartbeat(ctx);

  ctx.log.info('ready', {
    role: 'alm',
    publishes: TOPICS.almRebalance,
    listens: [TOPICS.executorReceipt, TOPICS.heartbeat],
  });

  process.stdin.resume();
  void stopHeartbeat;
}

main().catch((err: unknown) => {
  console.error('[alm:fatal]', err);
  process.exit(1);
});
