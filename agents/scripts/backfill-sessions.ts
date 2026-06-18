// Backfill missing PM + Router sessions for the funded EOA.
//
// The original delegation flow only landed 2/4 registerSession POSTs for
// 0x56b586d5...7012 (likely a UI race during the Safe→7702 pivot). Since
// the user already signed a typed-data delegation message authorising all
// 4 agents, the policy hash is the same — we just need to materialise the
// rows for pm and router so the tick loop sees this EOA.

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { PrismaClient } from '@prisma/client';

const SAFE = '0x56b586d5476efa2d1f2375904be62833c8c17012';
// Reuse the policy hash + validUntil from the existing alm/executor rows
// so the row tells the same story (same delegation).
const db = new PrismaClient();

async function main() {
  const existing = await db.session.findMany({
    where: { safeAddress: SAFE, validUntil: { gt: new Date() } },
  });
  if (existing.length === 0) {
    console.error(`No active sessions for ${SAFE} — re-run delegation in UI.`);
    process.exit(1);
  }
  const template = existing[0]!;
  console.log(
    `Using template from ${template.agent} (validUntil=${template.validUntil.toISOString()})`,
  );

  for (const agent of ['pm', 'router'] as const) {
    if (existing.some((s) => s.agent === agent)) {
      console.log(`✓ ${agent} already registered, skipping`);
      continue;
    }
    // Synthetic session address — agents don't actually pull these to
    // sign txs in 7702 mode; they only check the row exists. Using
    // template's session address is fine for demo. In prod the UI signs
    // a per-agent key.
    await db.session.upsert({
      where: { safeAddress_agent: { safeAddress: SAFE, agent } },
      create: {
        safeAddress: SAFE,
        agent,
        sessionAddress: template.sessionAddress,
        policyHash: template.policyHash,
        validUntil: template.validUntil,
      },
      update: {},
    });
    console.log(`+ inserted ${agent}`);
  }

  // Make sure the user row has chains set so PM resolves the right chain.
  await db.user.update({
    where: { safeAddress: SAFE },
    data: { chains: 'mainnet' },
  });
  console.log(`+ user.chains = mainnet`);

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
