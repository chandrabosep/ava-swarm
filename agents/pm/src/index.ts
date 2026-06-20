// Portfolio Manager.
//
// Speedrun role: the lead agent that hires specialist agents, paying each
// via x402 and rating them via ERC-8004 (see hire.ts). This is the demo.
//
// The legacy DeFi rebalance pipeline (PM proposes an allocation → Router
// decomposes into swaps → Executor settles) is OFF by default — it spammed
// the feed with simulated sepolia swaps that are off-message for an
// Avalanche agentic-payments demo. Re-enable with PM_REBALANCE_ENABLED=true.

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  type SwarmMessage,
} from '@swarm/shared';
import { startTick } from './tick.js';
import { startDebateInbox } from './debate.js';
import { startHireLoop } from './hire.js';

const REBALANCE_ENABLED =
  (process.env.PM_REBALANCE_ENABLED ?? 'false').toLowerCase() === 'true';

async function main() {
  const ctx = await bootAgent('pm');
  const stopHeartbeat = startHeartbeat(ctx);

  // Speedrun: Agentic Payments — PM hires specialist agents, paying each via
  // x402 and rating them via ERC-8004. Self-contained; runs independent of
  // user sessions so the demo works as soon as the PM wallet is funded.
  const stopHire = startHireLoop(ctx);

  // Legacy rebalance swap pipeline — off unless explicitly enabled.
  let stopTick = () => {};
  let stopInbox = () => {};
  if (REBALANCE_ENABLED) {
    // Debate feedback inbox must register its LISTEN before the first tick,
    // otherwise peers' immediate replies hit an empty subscriber set.
    stopInbox = startDebateInbox(ctx);
    stopTick = startTick(ctx);

    // Post-trade context for the next tick.
    void (async () => {
      for await (const msg of ctx.axl.subscribe<SwarmMessage<unknown>>(
        TOPICS.executorReceipt,
      )) {
        ctx.log.info('observed receipt', { from: msg.from });
      }
    })();
  } else {
    ctx.log.info('rebalance pipeline disabled (PM_REBALANCE_ENABLED!=true)');
  }

  ctx.log.info('ready', {
    role: 'pm',
    mode: REBALANCE_ENABLED ? 'hire+rebalance' : 'hire-only',
    hireLoop: true,
    rebalance: REBALANCE_ENABLED,
  });

  process.stdin.resume();
  void stopHeartbeat;
  void stopTick;
  void stopInbox;
  void stopHire;
}

main().catch((err: unknown) => {
  console.error('[pm:fatal]', err);
  process.exit(1);
});
