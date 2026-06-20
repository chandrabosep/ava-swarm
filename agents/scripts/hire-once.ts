// Fire exactly ONE real x402 hiring round on Avalanche Fuji, then exit.
//
// This runs the SAME code path as the live PM loop (pm/src/hire.ts) — it
// ranks the specialists by ERC-8004 reputation, pays each via x402 in real
// USDC on Fuji, scores the result, and writes ERC-8004 feedback. Every
// settlement is a real on-chain tx resolvable on Snowtrace, recorded as an
// `x402.hire` event the dashboard reads.
//
// Use it to trigger a live hire on demand (e.g. while recording) instead of
// waiting out the 45s PM loop.
//
// Requirements (this is REAL testnet, not a mock):
//   - PM_SERVICE_PRIVKEY wallet funded with Fuji test-USDC + a little AVAX
//     (check with: npx tsx --env-file=.env scripts/verify-speedrun.ts)
//   - The marketplace service reachable at MARKETPLACE_URL
//     (run it with: npm run dev:marketplace  — or  npm run dev:all)
//   - X402_FACILITATOR_URL reachable
//
// Run:
//   npx tsx --env-file=.env scripts/hire-once.ts

import { bootAgent } from '@swarm/shared';
import { runHiringRound } from '../pm/src/hire.js';

async function main() {
  const ctx = await bootAgent('pm');
  console.log('→ Firing one real x402 hiring round on Fuji…\n');
  await runHiringRound(ctx);
  console.log(
    '\n✓ Round complete. Open the dashboard "Live x402 payments" panel — the\n' +
      '  new hires carry real Snowtrace links. Set VITE_DEMO_FEED=false so the\n' +
      '  dashboard shows this real data.',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ Hiring round failed:', err instanceof Error ? err.message : err);
  console.error(
    '\nMost common causes:\n' +
      '  • PM wallet has no Fuji USDC/AVAX → fund it (faucet.avax.network)\n' +
      '  • Marketplace not running → npm run dev:marketplace\n' +
      '  • Facilitator unreachable → check X402_FACILITATOR_URL',
  );
  process.exit(1);
});
