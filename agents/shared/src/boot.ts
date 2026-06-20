// Common boot sequence used by every agent.
//
// Each agent's `src/index.ts` calls `bootAgent('pm' | 'alm' | ...)` and
// gets back a ready-to-use context: logger, AXL client, peer identity,
// DB connectivity verified. Heartbeat + graceful shutdown are wired up
// here so individual agents stay focused on their actual work.

import { db, disconnectDb, type AgentRole } from './db.js';
import { TOPICS } from './topics.js';
import { MeshBus } from './mesh.js';
import { createLogger, type Logger } from './log.js';
import { serviceAddress } from './keys.js';
import { ensureAgentIdentity } from './erc8004.js';
import { pgGossip, type PgGossipBus } from './pg-gossip.js';

export interface AgentContext {
  role: AgentRole;
  log: Logger;
  /** Inter-agent pub/sub. Postgres LISTEN/NOTIFY under the hood (see
   *  mesh.ts); paired with the DB-poll fallback in intent-poll.ts. */
  axl: MeshBus;
  /** The raw Postgres gossip bus the mesh rides on. Some agents publish/
   *  subscribe to it directly for the debate protocol. */
  pg: PgGossipBus;
  /** Stable per-agent identity (the agent role). */
  identity: { peerId: string; pubkey: string };
  /** ERC-8004 on-chain agentId, or null in degraded mode (registries
   *  unconfigured / chain unreachable). Set during boot. */
  agentId: number | null;
}

/** Patterns for transient DB/socket errors we should survive rather than
 *  crash on. Supabase's free-tier pooler resets idle/long-lived connections
 *  (ECONNRESET, "Server has closed the connection", etc.); the pg-gossip bus
 *  and Prisma both reconnect on the next call, so a crash here just churns
 *  the process and stalls routing. */
const TRANSIENT_CONN_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|Server has closed|kind: ?Closed|Closed the connection|socket hang up/i;

let guardsInstalled = false;
function installResilienceHandlers(log: Logger): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const isTransient = (err: unknown): boolean => {
    const msg = err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err);
    return TRANSIENT_CONN_RE.test(msg);
  };
  process.on('unhandledRejection', (reason) => {
    if (isTransient(reason)) {
      log.warn('transient connection error (recovering)', {
        err: reason instanceof Error ? reason.message : String(reason),
      });
      return; // swallow — pg/Prisma reconnect on next use
    }
    log.error('unhandledRejection', {
      err: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    if (isTransient(err)) {
      log.warn('transient connection error (recovering)', { err: err.message });
      return; // swallow
    }
    log.error('uncaughtException — exiting for restart', { err: err.stack ?? err.message });
    process.exit(1);
  });
}

export async function bootAgent(role: AgentRole): Promise<AgentContext> {
  const log = createLogger(role);
  installResilienceHandlers(log);
  log.info('booting');

  // Service identity — log the public address so the operator can paste
  // it into the extension's hardcoded service-address constants.
  let agentId: number | null = null;
  try {
    const addr = serviceAddress(role);
    log.info('service identity', { address: addr });
    // ERC-8004 on-chain identity. Non-fatal: register (or reuse) the agent's
    // trustless-agent NFT so its x402 payments are reputation-traceable.
    agentId = await ensureAgentIdentity(role, log);
  } catch (err) {
    log.warn('service privkey missing — agent cannot sign', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Inter-agent mesh — Postgres LISTEN/NOTIFY (see mesh.ts). No daemon,
  // no network probe; shares the pgGossip connection opened below.
  const axl = new MeshBus(role);
  const identity = await axl.identity();
  log.info('mesh up', { peerId: identity.peerId });

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

  // Sentinel User row that satisfies the AgentState FK for global
  // (non-tenant-scoped) heartbeat rows. Idempotent.
  await db().user.upsert({
    where: { walletAddress: GLOBAL_HEARTBEAT_KEY },
    update: {},
    create: {
      walletAddress: GLOBAL_HEARTBEAT_KEY,
      ownerEoa: GLOBAL_HEARTBEAT_KEY,
      chains: '',
    },
  });

  // PG gossip bus — opens a dedicated LISTEN connection lazily on the
  // first publish/subscribe. Agents that never subscribe (e.g. API,
  // sometimes ALM/Executor) don't open a session at all, which keeps
  // us under Supabase's 15-client session pool cap on free tier.
  const pg = pgGossip();
  pg.onLifecycle = (event, meta) => log.info(event, meta);

  installShutdownHandlers(log, pg);
  return { role, log, axl, pg, identity, agentId };
}

/**
 * Periodically publish a heartbeat on the mesh AND persist it to the DB so
 * the dashboard's status query can read "X seconds ago" without a mesh
 * subscription.
 *
 * We use the AgentState table (one row per agent globally — null
 * walletAddress placeholder) for the latest heartbeat, since per-tenant
 * agent state is already tracked elsewhere. The Event table gets one row
 * per heartbeat for the activity timeline.
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
      const ts = Date.now();
      // Mesh gossip — fan out to peer agents over Postgres LISTEN/NOTIFY.
      await ctx.axl
        .publish({
          topic: TOPICS.heartbeat,
          payload: {
            fromAgent: ctx.role,
            peerId: ctx.identity.peerId,
            users,
            ts,
          },
        })
        .catch(() => {
          /* gossip down: heartbeat still lands in DB below */
        });

      // DB — global row keyed by (agent, GLOBAL_HEARTBEAT_KEY) so the
      // API can fetch the latest tick per agent in one query without
      // needing a per-tenant scan.
      await db().agentState.upsert({
        where: {
          agent_walletAddress: {
            agent: ctx.role,
            walletAddress: GLOBAL_HEARTBEAT_KEY,
          },
        },
        update: { state: { peerId: ctx.identity.peerId, users, ts } },
        create: {
          agent: ctx.role,
          walletAddress: GLOBAL_HEARTBEAT_KEY,
          state: { peerId: ctx.identity.peerId, users, ts },
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

/**
 * Sentinel walletAddress used to key the per-agent global heartbeat
 * row. Not a real wallet — the User row created on first boot
 * satisfies the FK; we delete it on shutdown if nothing else
 * references it.
 */
export const GLOBAL_HEARTBEAT_KEY = '0x0000000000000000000000000000000000000000';

function installShutdownHandlers(log: Logger, pg?: PgGossipBus): void {
  const shutdown = async (signal: string) => {
    log.info(`received ${signal} — shutting down`);
    // Close the PG gossip session FIRST so we release the slot in
    // Supabase's session pool. Without this, hard restarts pile up
    // orphaned sessions until we hit EMAXCONNSESSION.
    if (pg) {
      try {
        await pg.close();
      } catch (err) {
        log.warn('pg gossip close threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
