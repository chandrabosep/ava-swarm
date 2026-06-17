// Intent Router.
//
// Subscribes to two AXL topics:
//   - swarm.pm.allocation  (allocation targets from PM)
//   - swarm.alm.rebalance  (rebalance swap requests from ALM)
//
// Decomposes each AllocationIntent into per-token swap intents,
// nets opposing intents within a window, queries Uniswap for the best
// route per surviving intent, and publishes RoutedIntent messages on
// swarm.router.routed for the Executor to consume.
//
// This commit boots + heartbeats + logs incoming messages. Netting +
// venue selection logic lands in commit 5.

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  type SwarmMessage,
} from '@swarm/shared';

async function main() {
  const ctx = await bootAgent('router');
  const stopHeartbeat = startHeartbeat(ctx);

  // PM intents
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<unknown>>(
      TOPICS.pmAllocation,
    )) {
      ctx.log.info('inbox: pm allocation', {
        from: msg.from,
        kind: msg.kind,
      });
      // TODO commit 5 — decompose + dispatch
    }
  })();

  // ALM intents
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<unknown>>(
      TOPICS.almRebalance,
    )) {
      ctx.log.info('inbox: alm rebalance', {
        from: msg.from,
        kind: msg.kind,
      });
      // TODO commit 5 — net + dispatch
    }
  })();

  ctx.log.info('ready', {
    role: 'router',
    publishes: TOPICS.routerRouted,
    listens: [TOPICS.pmAllocation, TOPICS.almRebalance],
  });

  process.stdin.resume();
  void stopHeartbeat;
}

main().catch((err: unknown) => {
  console.error('[router:fatal]', err);
  process.exit(1);
});
