// Common boot sequence used by every agent.
//
// Each agent's `src/index.ts` calls `bootAgent('pm' | 'alm' | ...)` and
// gets back a ready-to-use context: logger, AXL client, peer identity,
// DB connectivity verified. Heartbeat + graceful shutdown are wired up
// here so individual agents stay focused on their actual work.

import { db, disconnectDb, type AgentRole } from './db.js';
import { AxlClient, TOPICS } from './axl.js';
import { env } from './env.js';
import { createLogger, type Logger } from './log.js';
import { serviceAddress } from './keys.js';

export interface AgentContext {
  role: AgentRole;
  log: Logger;
  axl: AxlClient;
  /** Peer id + pubkey from the local AXL daemon. */
  identity: { peerId: string; pubkey: string };
}

export async function bootAgent(role: AgentRole): Promise<AgentContext> {
  const log = createLogger(role);
  log.info('booting');

  // Service identity — log the public address so the operator can paste
  // it into the extension's hardcoded service-address constants.
  try {
    const addr = serviceAddress(role);
    log.info('service identity', { address: addr });
  } catch (err) {
    log.warn('service privkey missing — agent cannot sign', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // AXL — non-fatal if down; agent operates in degraded mode.
  const axl = new AxlClient(env.axlEndpoint(role));
  let identity = { peerId: 'offline', pubkey: '0x' };
  try {
    identity = await axl.identity();
    log.info('axl up', { peerId: identity.peerId });
  } catch (err) {
    log.warn('axl down — running without inter-agent comms', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // DB — fatal if down; agent can't track tenants without it.
  try {
    await db().$queryRaw`SELECT 1`;
    log.info('db up');
  } catch (err) {
    log.error('db connect failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  installShutdownHandlers(log);
  return { role, log, axl, identity };
}

/**
 * Periodically publish a heartbeat on AXL with the current user count so
 * the dashboard can show "X users served" per agent.
 */
export function startHeartbeat(
  ctx: AgentContext,
  intervalMs = 10_000,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const users = await db().user.count();
      await ctx.axl.publish({
        topic: TOPICS.heartbeat,
        payload: {
          fromAgent: ctx.role,
          peerId: ctx.identity.peerId,
          users,
          ts: Date.now(),
        },
      });
    } catch (err) {
      ctx.log.warn('heartbeat failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const id = setInterval(tick, intervalMs);
  void tick(); // emit one immediately so dashboard sees it without delay
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

function installShutdownHandlers(log: Logger): void {
  const shutdown = async (signal: string) => {
    log.info(`received ${signal} — shutting down`);
    try {
      await disconnectDb();
    } catch (err) {
      log.warn('db disconnect threw', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
