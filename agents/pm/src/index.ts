// Portfolio Manager — LLM-driven.
//
// Tick every 5 minutes: pull each user's portfolio, ask Claude what
// the target allocation should be, publish AllocationIntent on AXL.
// Router translates that into per-token swaps; Executor settles them.

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  type SwarmMessage,
} from '@swarm/shared';
import { startTick } from './tick.js';

async function main() {
  const ctx = await bootAgent('pm');
  const stopHeartbeat = startHeartbeat(ctx);
  const stopTick = startTick(ctx);

  // Listen for executor receipts so the LLM has post-trade context next tick.
  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<unknown>>(
      TOPICS.executorReceipt,
    )) {
      ctx.log.info('observed receipt', { from: msg.from });
    }
  })();

  ctx.log.info('ready', {
    role: 'pm',
    publishes: TOPICS.pmAllocation,
    listens: [TOPICS.executorReceipt, TOPICS.heartbeat],
  });

  process.stdin.resume();
  void stopHeartbeat;
  void stopTick;
}

main().catch((err: unknown) => {
  console.error('[pm:fatal]', err);
  process.exit(1);
});
