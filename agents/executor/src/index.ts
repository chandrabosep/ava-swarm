// Swap Executor.
//
// Subscribes to swarm.router.routed. For each RoutedIntent, persists it
// to Postgres and kicks off execution. Execution flow lives in
// ./execute.ts (Uniswap quote → KeeperHub submit → publish receipt).

import {
  bootAgent,
  startHeartbeat,
  TOPICS,
  db,
  type RoutedIntent,
  type SwarmMessage,
} from '@swarm/shared';
import { execute } from './execute.js';

async function main() {
  const ctx = await bootAgent('executor');
  const stopHeartbeat = startHeartbeat(ctx);

  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<RoutedIntent>>(
      TOPICS.routerRouted,
    )) {
      const env = msg.payload;
      if (!env || !env.payload) continue;

      const intent = env.payload;
      const safeAddress = env.safeAddress as `0x${string}`;

      // Persist before we touch any external service so we have an audit
      // trail even if KeeperHub explodes mid-call.
      const row = await db().intent.create({
        data: {
          safeAddress,
          fromAgent: 'router',
          payload: intent as unknown as object,
          status: 'pending',
        },
      });

      // Fire and forget — execute() handles its own errors and writes
      // the final state back to DB.
      void execute({ ctx, intentId: row.id, safeAddress, intent }).catch(
        (err) =>
          ctx.log.error('unhandled execute error', {
            err: err instanceof Error ? err.message : String(err),
          }),
      );
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
