// Print recent intent.executed events with their full txHashes so we
// can paste them into inspect-tx.ts (which auto-detects which chain
// each tx actually landed on).
//
// Run: npx tsx scripts/list-tx-events.ts

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { PrismaClient } from '@prisma/client';

async function main() {
  const db = new PrismaClient();
  const events = await db.event.findMany({
    where: { kind: 'intent.executed' },
    orderBy: { createdAt: 'desc' },
    take: 8,
  });
  console.log(`Found ${events.length} executed events:\n`);
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const intentId = (p.intentId as string | undefined) ?? '?';
    const txHash = (p.txHash as string | undefined) ?? '-';
    const ago = ((Date.now() - e.createdAt.getTime()) / 1000).toFixed(0);
    console.log(`  ${ago}s ago  intent=${intentId.slice(0, 8)}  tx=${txHash}`);
  }
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
