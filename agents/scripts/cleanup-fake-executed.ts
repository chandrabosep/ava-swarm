// Same cleanup as cleanup-fake-executed.sql, but runs through Prisma so
// you don't need psql installed. Two passes:
//   1. Delete leftover mainnet/base/unichain Router rows from before
//      the chain fix (and their orphaned events).
//   2. Demote any 'executed' intents that don't have a real txHash event
//      to 'failed' so the dashboard reflects truth.
//
// Run from agents/:
//   npx tsx scripts/cleanup-fake-executed.ts

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  // 1. Delete mainnet Router rows
  const mainnetIntents = await db.intent.findMany({
    where: {
      fromAgent: 'router',
      payload: { path: ['chain'], in: ['mainnet', 'base', 'unichain'] },
    },
    select: { id: true },
  });
  const mainnetIds = mainnetIntents.map((i) => i.id);
  if (mainnetIds.length > 0) {
    await db.intent.deleteMany({ where: { id: { in: mainnetIds } } });
  }
  console.log(`✓ deleted ${mainnetIds.length} mainnet/base/unichain router intents`);

  // 1b. Delete cross-chain corrupt rows: intent says chain=sepolia (or
  //     base-sepolia) but tokenIn/tokenOut is a mainnet address. These
  //     are the stale rows the address-vs-chain validator now blocks.
  const TESTNET_TOKENS_BY_CHAIN: Record<string, Set<string>> = {
    sepolia: new Set([
      '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
      '0x29f2d40b0605204364af54ec677bd022da425d03',
      '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      '0x0000000000000000000000000000000000000000',
    ]),
    'base-sepolia': new Set([
      '0x4200000000000000000000000000000000000006',
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      '0x0000000000000000000000000000000000000000',
    ]),
  };
  const allRouter = await db.intent.findMany({
    where: { fromAgent: 'router' },
    select: { id: true, payload: true },
  });
  const corruptIds: string[] = [];
  for (const i of allRouter) {
    const p = i.payload as
      | { chain?: string; tokenIn?: string; tokenOut?: string }
      | null;
    const chain = p?.chain;
    const allowed = chain ? TESTNET_TOKENS_BY_CHAIN[chain] : undefined;
    if (!allowed) continue; // only validate testnet rows
    const tokenIn = (p?.tokenIn ?? '').toLowerCase();
    const tokenOut = (p?.tokenOut ?? '').toLowerCase();
    if (!allowed.has(tokenIn) || !allowed.has(tokenOut)) {
      corruptIds.push(i.id);
    }
  }
  if (corruptIds.length > 0) {
    await db.intent.deleteMany({ where: { id: { in: corruptIds } } });
  }
  console.log(`✓ deleted ${corruptIds.length} chain-vs-address corrupt intents`);

  // 2. Delete orphan execution events. Pull live intent ids first.
  const live = await db.intent.findMany({ select: { id: true } });
  const liveSet = new Set(live.map((i) => i.id));
  const candidateEvents = await db.event.findMany({
    where: {
      kind: { in: ['intent.routed', 'intent.executed', 'intent.failed', 'otc.advertised'] },
    },
    select: { id: true, payload: true },
  });
  const orphanIds: string[] = [];
  for (const e of candidateEvents) {
    const intentId = (e.payload as { intentId?: string } | null)?.intentId;
    if (!intentId || !liveSet.has(intentId)) orphanIds.push(e.id);
  }
  if (orphanIds.length > 0) {
    await db.event.deleteMany({ where: { id: { in: orphanIds } } });
  }
  console.log(`✓ deleted ${orphanIds.length} orphan events`);

  // 3. Demote fake-executed intents.
  const realTxIntentIds = new Set<string>();
  const realTxEvents = await db.event.findMany({
    where: { kind: 'intent.executed' },
    select: { payload: true },
  });
  for (const e of realTxEvents) {
    const p = e.payload as { intentId?: string; txHash?: string } | null;
    if (
      p?.intentId &&
      typeof p.txHash === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(p.txHash)
    ) {
      realTxIntentIds.add(p.intentId);
    }
  }
  const suspect = await db.intent.findMany({
    where: { status: 'executed', fromAgent: { not: 'pm' } },
    select: { id: true },
  });
  const toDemote = suspect.map((i) => i.id).filter((id) => !realTxIntentIds.has(id));
  if (toDemote.length > 0) {
    await db.intent.updateMany({
      where: { id: { in: toDemote } },
      data: { status: 'failed' },
    });
  }
  console.log(`✓ demoted ${toDemote.length} fake-executed intents to 'failed'`);

  // 4. Show final tally.
  const tally = await db.intent.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  console.log('\n=== intent status tally ===');
  for (const t of tally) {
    console.log(`  ${t.status.padEnd(12)} ${t._count._all}`);
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
