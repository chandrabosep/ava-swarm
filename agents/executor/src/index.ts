// Swap Executor.
//
// Subscribes to swarm.router.routed. For each RoutedIntent, persists it
// to Postgres and kicks off execution. Execution flow lives in
// ./execute.ts (Uniswap quote → KeeperHub submit → publish receipt).

import {
  bootAgent,
  env,
  startHeartbeat,
  startIntentPoll,
  TOPICS,
  db,
  type RoutedIntent,
  type SwarmMessage,
} from '@swarm/shared';
import { execute } from './execute.js';

const TESTNET_CHAINS = new Set(['sepolia', 'base-sepolia']);

/** Hard guard: drop any RoutedIntent that doesn't match the testnet
 *  policy. Stale rows from a prior mainnet config or a renegade router
 *  process get marked failed instead of being executed. */
async function rejectMainnetIfTestnet(
  intentId: string,
  intent: RoutedIntent,
  reason: string,
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: object) => void,
): Promise<boolean> {
  if (!env.useTestnet()) return false;
  if (TESTNET_CHAINS.has(intent.chain)) return false;
  log('error', 'executor refusing mainnet intent under USE_TESTNET', {
    intentId,
    chain: intent.chain,
    reason,
  });
  // Mark failed so it stops cycling through the poll.
  await db()
    .intent.update({
      where: { id: intentId },
      data: { status: 'failed' },
    })
    .catch(() => {});
  return true; // signals "rejected"
}

async function main() {
  const ctx = await bootAgent('executor');
  const stopHeartbeat = startHeartbeat(ctx);

  // Probe KeeperHub MCP at boot. Lists tools, then explores the
  // actions/templates/plugins/integrations catalogs so we can see what
  // shape KH actually exposes for our org. Non-fatal: failures are
  // logged and the executor continues.
  try {
    const { listKeeperhubTools, callKeeperhubTool } = await import(
      './keeperhub-mcp.js'
    );
    const tools = await listKeeperhubTools();
    ctx.log.info('keeperhub mcp tools', {
      count: tools.length,
      names: tools.map((t) => t.name),
    });

    const probes: Array<[string, Record<string, unknown>]> = [
      // Pin the swap action's full schema so we can match the params shape.
      ['search_protocol_actions', { query: 'swap-exact-input' }],
      ['list_integrations', {}],
    ];
    for (const [name, args] of probes) {
      try {
        const res = (await callKeeperhubTool(name, args)) as {
          content?: Array<{ text?: string }>;
          structuredContent?: unknown;
        };
        const text =
          res.structuredContent !== undefined
            ? JSON.stringify(res.structuredContent)
            : (res.content?.[0]?.text ?? '');
        // Print full schema this time so we can see required+optional fields.
        console.log(`[keeperhub-probe] ${name} -> ${text.slice(0, 3000)}`);
      } catch (err) {
        console.log(
          `[keeperhub-probe] ${name}(${JSON.stringify(args)}) -> ERROR ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    ctx.log.warn('keeperhub mcp probe failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // DB-poll fallback — picks up Router-written intents even when AXL is
  // offline. Router writes status='routed', we claim → 'executing' →
  // 'executed' (or 'failed').
  startIntentPoll<RoutedIntent>({
    fromAgent: 'router',
    pendingStatus: 'routed',
    inFlightStatus: 'executing',
    completedStatus: 'executed',
    failedStatus: 'failed',
    log: (level, msg, meta) => ctx.log[level](msg, meta),
    handle: async (row) => {
      const intent = row.payload;
      if (!intent) return;
      const rejected = await rejectMainnetIfTestnet(
        row.id,
        intent,
        'db-poll',
        (level, msg, meta) => ctx.log[level](msg, meta),
      );
      if (rejected) return;
      await execute({
        ctx,
        intentId: row.id,
        walletAddress: row.walletAddress as `0x${string}`,
        intent,
      });
    },
  });

  void (async () => {
    for await (const msg of ctx.axl.subscribe<SwarmMessage<RoutedIntent>>(
      TOPICS.routerRouted,
    )) {
      const envelope = msg.payload;
      if (!envelope || !envelope.payload) continue;

      const intent = envelope.payload;
      const walletAddress = envelope.walletAddress as `0x${string}`;

      // Reject before persisting so a renegade publisher can't pollute
      // the DB with mainnet rows under USE_TESTNET=true.
      if (env.useTestnet() && !TESTNET_CHAINS.has(intent.chain)) {
        ctx.log.error(
          'executor refusing mainnet intent over AXL under USE_TESTNET',
          { chain: intent.chain, walletAddress },
        );
        continue;
      }

      // Persist before we touch any external service so we have an audit
      // trail even if KeeperHub explodes mid-call.
      const row = await db().intent.create({
        data: {
          walletAddress,
          fromAgent: 'router',
          payload: intent as unknown as object,
          status: 'pending',
        },
      });

      // Fire and forget — execute() handles its own errors and writes
      // the final state back to DB.
      void execute({ ctx, intentId: row.id, walletAddress, intent }).catch(
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
