// Portfolio Manager — the LLM-driven agent.
//
// On a tick (every 5 minutes for now), iterates every enrolled user,
// pulls their portfolio + market context, asks Claude what the target
// allocation should be, and publishes an AllocationIntent on AXL for
// the Router to pick up.
//
// In this commit we only boot + heartbeat. The decision logic lands in
// the next commit.

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  type SwarmMessage,
} from '@swarm/shared';

async function main() {
  const ctx = await bootAgent('pm');
  const stopHeartbeat = startHeartbeat(ctx);

  // Listen for executor receipts so we know when our allocation intents
  // actually translate to onchain action — useful for the LLM's next-tick
  // context.
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<unknown>>(
      TOPICS.executorReceipt,
    )) {
      ctx.log.info('observed receipt', {
        from: msg.from,
        kind: msg.kind,
      });
    }
  })();

  ctx.log.info('ready', {
    role: 'pm',
    publishes: TOPICS.pmAllocation,
    listens: [TOPICS.executorReceipt, TOPICS.heartbeat],
  });

  // Keep the process alive. Tick logic added in a later commit.
  process.stdin.resume();
  // (defensive — never reached, but prevents an unused-binding lint)
  void stopHeartbeat;
}

main().catch((err: unknown) => {
  console.error('[pm:fatal]', err);
  process.exit(1);
});
