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
    orderBy: [{ walletAddress: 'asc' }, { agent: 'asc' }],
    select: {
      walletAddress: true,
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
        wallet: s.walletAddress.slice(0, 10) + '…' + s.walletAddress.slice(-4),
        agent: s.agent,
        session: s.sessionAddress.slice(0, 10) + '…',
        expiresInH: ((s.validUntil.getTime() - now.getTime()) / 3.6e6).toFixed(1),
      })),
    );

  const users = await db.user.findMany({
    select: {
      walletAddress: true,
      riskProfile: true,
      chains: true,
      customConfig: true,
    },
  });
  console.log('\n=== Users ===');
  console.table(
    users.map((u) => ({
      wallet: u.walletAddress.slice(0, 10) + '…' + u.walletAddress.slice(-4),
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
        wallet:
          s.walletAddress === '0x0000000000000000000000000000000000000000'
            ? '(global)'
            : s.walletAddress.slice(0, 10) + '…' + s.walletAddress.slice(-4),
        keys: Object.keys(st).join(','),
        lastTick: lastTick
          ? new Date(lastTick).toISOString().replace('T', ' ').slice(5, 19)
          : '-',
        updatedAgo: ageSec.toFixed(0) + 's',
      };
    }),
  );

  // Recent execution receipts — these hold the txHashes from successful
  // swaps. Useful when an intent is marked 'executed' but the log file
  // was overwritten and we still want the chain receipt.
  const events = await db.event.findMany({
    where: {
      kind: { in: ['intent.executed', 'intent.failed'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('\n=== Last 10 execution events ===');
  console.table(
    events.map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return {
        kind: e.kind,
        intent: (p.intentId as string | undefined)?.slice(0, 8),
        txHash:
          typeof p.txHash === 'string'
            ? (p.txHash as string).slice(0, 14) + '…'
            : '-',
        ago: ((Date.now() - e.createdAt.getTime()) / 1000).toFixed(0) + 's',
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
      walletAddress: true,
      createdAt: true,
      payload: true,
    },
  });
  console.log('\n=== Last 15 intents (with chain from payload) ===');
  console.table(
    intents.map((i) => {
      const p = i.payload as
        | { kind?: string; chain?: string; tokenIn?: string; tokenOut?: string }
        | null;
      return {
        id: i.id.slice(0, 8),
        from: i.fromAgent,
        status: i.status,
        kind: p?.kind ?? '?',
        chain: p?.chain ?? '-',
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
