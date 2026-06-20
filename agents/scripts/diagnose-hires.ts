// Print the real outcome of the last x402 hire attempts — including the
// exact `error` string on failures — so we can pinpoint why live hires
// aren't settling (funding vs marketplace URL vs facilitator).
//
//   npx tsx --env-file=.env scripts/diagnose-hires.ts

import { db } from '@swarm/shared';

const MARKET_KEY = '0x0000000000000000000000000000000000000000';

async function main() {
  const rows = await db().event.findMany({
    where: { walletAddress: MARKET_KEY, kind: 'x402.hire' },
    orderBy: { createdAt: 'desc' },
    take: 12,
  });

  if (rows.length === 0) {
    console.log('No x402.hire events yet. Has the PM hire loop run? (npm run dev:all)');
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const when = r.createdAt.toISOString().slice(11, 19);
    if (p.ok) {
      ok++;
      console.log(
        `✓ ${when}  ${String(p.label)}  paid ${String(p.price)}  ` +
          `tx=${String(p.payTxHash ?? '—')}  score=${String(p.score)}`,
      );
    } else {
      failed++;
      console.log(
        `✗ ${when}  ${String(p.label)}  ` +
          `status=${String(p.status ?? '')}  error=${String(p.error ?? 'unknown')}`,
      );
    }
  }
  console.log(`\n${ok} ok · ${failed} failed (of last ${rows.length}).`);
  if (failed > 0) {
    console.log(
      'If errors mention insufficient funds → fund the PM wallet (faucet.avax.network).\n' +
        'If ECONNREFUSED / fetch failed → start the marketplace (npm run dev:marketplace).\n' +
        'If 402 / facilitator → check X402_FACILITATOR_URL reachability.',
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
