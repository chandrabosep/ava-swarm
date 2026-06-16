// Swap Executor.
//
// Subscribes to swarm.router.routed. Each RoutedIntent specifies a
// venue (Uniswap Trading API), a token pair, an amount, and a min-out.
// Executor builds the swap calldata, signs a UserOp with the user's
// session privkey (loaded from DB and decrypted in-memory), and submits
// via KeeperHub for guaranteed execution + retry + MEV protection.
//
// This commit boots + heartbeats. Uniswap quote + KeeperHub submit
// lands in commit 3.

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  type SwarmMessage,
} from '@swarm/shared';

async function main() {
  const ctx = await bootAgent('executor');
  const stopHeartbeat = startHeartbeat(ctx);

  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<unknown>>(
      TOPICS.routerRouted,
    )) {
      ctx.log.info('inbox: routed intent', {
        from: msg.from,
        kind: msg.kind,
      });
      // TODO commit 3 — quote via Uniswap, submit via KeeperHub, publish receipt
    }
  })();

  ctx.log.info('ready', {
    role: 'executor',
    publishes: TOPICS.executorReceipt,
    listens: [TOPICS.routerRouted],
  });

  process.stdin.resume();
  void stopHeartbeat;
}

main().catch((err: unknown) => {
  console.error('[executor:fatal]', err);
  process.exit(1);
});
