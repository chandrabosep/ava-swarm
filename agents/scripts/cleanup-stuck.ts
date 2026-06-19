// Mark non-terminal intents (status = pending | routed | executing) as
// failed so the executor's poll loop stops retrying swaps that can never
// settle (e.g. legacy EOA-based child intents emitted before
// PM_PORTFOLIO_FROM=kh, where Router decomposed sells of WBTC/UNI that
// the KH wallet doesn't hold).
//
// Run with: npx tsx --env-file=.env scripts/cleanup-stuck.ts <wallet>

import { PrismaClient } from '@prisma/client';

async function main() {
  const wallet = process.argv[2];
  if (!wallet) {
    console.error('usage: cleanup-stuck.ts <wallet>');
    process.exit(2);
  }
  const db = new PrismaClient();
  const stuck = await db.intent.findMany({
    where: { walletAddress: wallet, status: { in: ['routed', 'pending', 'executing'] } },
    select: { id: true, status: true, fromAgent: true, payload: true },
  });
  console.log(`Found ${stuck.length} non-terminal intents for ${wallet}:`);
  for (const i of stuck) {
    const p = (i.payload as Record<string, unknown>) ?? {};
    const summary =
      p.kind === 'swap'
        ? `${p.fromSymbol}->${p.toSymbol} usd=${p.notionalUsd}`
        : p.kind === 'allocation'
          ? `alloc ${JSON.stringify(p.targets)}`
          : JSON.stringify(p).slice(0, 80);
    console.log(`  ${i.status.padEnd(9)} ${i.fromAgent.padEnd(8)} ${i.id} ${summary}`);
  }
  const r = await db.intent.updateMany({
    where: { walletAddress: wallet, status: { in: ['routed', 'pending', 'executing'] } },
    data: { status: 'failed' },
  });
  console.log(`\nMarked ${r.count} intents failed.`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
