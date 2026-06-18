// Clear PM's cadence marker for the funded EOA so the next poll loop
// (every 60s) ticks immediately instead of waiting out the conservative
// 60-min cadence. Useful for live demos.

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { PrismaClient } from '@prisma/client';

const WALLET = (process.argv[2] ??
  '0x56b586d5476efa2d1f2375904be62833c8c17012') as string;

const db = new PrismaClient();

async function main() {
  const row = await db.agentState.findUnique({
    where: { agent_walletAddress: { agent: 'pm', walletAddress: WALLET } },
  });
  if (!row) {
    console.log(`No PM state for ${WALLET} — next tick will be the first.`);
    return;
  }
  const state = (row.state as Record<string, unknown>) ?? {};
  delete state.lastTick;
  await db.agentState.update({
    where: { agent_walletAddress: { agent: 'pm', walletAddress: WALLET } },
    data: { state: state as never },
  });
  console.log(`✓ Cleared PM lastTick for ${WALLET}. Next poll (≤60s) will fire.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
