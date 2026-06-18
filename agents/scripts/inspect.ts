// Quick state inspector — run from agents/ with:
//   npx tsx scripts/inspect.ts
//
// Shows: active sessions, registered users, recent agent ticks, last 10
// intents and their statuses. Useful for verifying delegation registered
// and whether Router is actually getting allocations from PM.

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load agents/.env regardless of CWD
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const now = new Date();

  const sessions = await db.session.findMany({
    where: { validUntil: { gt: now } },
    orderBy: [{ safeAddress: 'asc' }, { agent: 'asc' }],
    select: {
      safeAddress: true,
      agent: true,
      sessionAddress: true,
      validUntil: true,
    },
  });
  console.log('\n=== Active sessions ===');
  if (sessions.length === 0) console.log('(none)');
  else
    console.table(
      sessions.map((s) => ({
        safe: s.safeAddress.slice(0, 10) + '…' + s.safeAddress.slice(-4),
        agent: s.agent,
        session: s.sessionAddress.slice(0, 10) + '…',
        expiresInH: ((s.validUntil.getTime() - now.getTime()) / 3.6e6).toFixed(1),
      })),
    );

  const users = await db.user.findMany({
    select: {
      safeAddress: true,
      riskProfile: true,
      chains: true,
      customConfig: true,
    },
  });
  console.log('\n=== Users ===');
  console.table(
    users.map((u) => ({
      safe: u.safeAddress.slice(0, 10) + '…' + u.safeAddress.slice(-4),
      profile: u.riskProfile,
      chains: u.chains,
      hasCustom: !!u.customConfig,
    })),
  );

  const states = await db.agentState.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 30,
  });
  console.log('\n=== Recent agent state (heartbeats + tick markers) ===');
  console.table(
    states.map((s) => {
      const st = (s.state as Record<string, unknown>) ?? {};
      const lastTick = st.lastTick as string | undefined;
      const ageSec = (Date.now() - s.updatedAt.getTime()) / 1000;
      return {
        agent: s.agent,
        safe:
          s.safeAddress === '0x0000000000000000000000000000000000000000'
            ? '(global)'
            : s.safeAddress.slice(0, 10) + '…' + s.safeAddress.slice(-4),
        keys: Object.keys(st).join(','),
        lastTick: lastTick
          ? new Date(lastTick).toISOString().replace('T', ' ').slice(5, 19)
          : '-',
        updatedAgo: ageSec.toFixed(0) + 's',
      };
    }),
  );

  const intents = await db.intent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      id: true,
      fromAgent: true,
      status: true,
      safeAddress: true,
      createdAt: true,
      payload: true,
    },
  });
  console.log('\n=== Last 15 intents ===');
  console.table(
    intents.map((i) => {
      const p = i.payload as { kind?: string } | null;
      return {
        from: i.fromAgent,
        status: i.status,
        kind: p?.kind ?? '?',
        safe: i.safeAddress.slice(0, 10) + '…' + i.safeAddress.slice(-4),
        ago: ((Date.now() - i.createdAt.getTime()) / 1000).toFixed(0) + 's',
      };
    }),
  );

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
