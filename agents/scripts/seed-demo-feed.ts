// Seed a realistic agent-feed sequence for a live demo.
//
// Writes one full PM → Router → Executor story to Postgres for a single
// wallet, so the dashboard's "Agent Feed" lights up instantly and
// deterministically — no LLM, no funded wallet, no cadence wait.
//
// What it inserts (newest first in the feed):
//   1. PM allocation intent  — risk-off → balanced deployment, with a
//      plain-language rationale + target chips (AVAX/DAI/UNI/USDC).
//   2. Router routed intent  — USDC → WAVAX on Avalanche Fuji, status
//      'executed', with a matching `intent.executed` event so the row
//      renders a clickable Snowtrace link and stays green.
//   3. Executor receipt      — 'mined' with the same tx hash.
//
// Run (from agents/):
//   npx tsx scripts/seed-demo-feed.ts [wallet] [txHash]
//
//   wallet  — defaults to the demo EOA below (matches force-tick.ts).
//   txHash  — OPTIONAL. Pass a REAL Fuji tx hash to make the Snowtrace
//             links resolve. If omitted, a placeholder hash is used and
//             the links will 404 (fine for a visual demo; use the real
//             tick path for genuine on-chain settlements).
//
// Reset between runs (clears ALL swap intents globally):
//   npx tsx scripts/clean-feed.ts --apply

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// ---------------------------------------------------------------------------
// Args + constants

const WALLET = (
  process.argv[2] ?? '0x56b586d5476efa2d1f2375904be62833c8c17012'
).toLowerCase();

/** Pass a real Fuji tx hash as argv[3] to make Snowtrace links resolve. */
const TX_HASH =
  process.argv[3] ?? `0x${randomBytes(32).toString('hex')}`;

// Avalanche Fuji token addresses (cosmetic — drive the feed's token chips).
const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const FUJI_WAVAX = '0xd00ae08403B9bbb9124bB305C09058E32C39A48c';

const now = Date.now();
const minsAgo = (m: number) => new Date(now - m * 60_000);

async function main() {
  // FK safety: Intent/Event rows reference User.walletAddress. Upsert the
  // user first so the seed works even on a fresh DB / wallet.
  await db.user.upsert({
    where: { walletAddress: WALLET },
    update: {},
    create: {
      walletAddress: WALLET,
      ownerEoa: WALLET,
      chains: 'avalanche-fuji',
      riskProfile: 'balanced',
    },
  });

  // 1. PM allocation — the centerpiece. Renders named target chips,
  //    a 'balanced' profile badge, and the LLM-style rationale quote.
  const alloc = await db.intent.create({
    data: {
      walletAddress: WALLET,
      fromAgent: 'pm',
      status: 'routed',
      createdAt: minsAgo(5),
      payload: {
        kind: 'allocation',
        profile: 'balanced',
        targets: [
          { symbol: 'AVAX', weight: 0.5 },
          { symbol: 'USDC', weight: 0.2 },
          { symbol: 'DAI', weight: 0.2 },
          { symbol: 'UNI', weight: 0.1 },
        ],
        rationale:
          'Treasury is 100% USDC (fully risk-off) against a balanced target ' +
          'of 20% stables. Deploying ~80% into the AVAX/DAI/UNI universe to ' +
          'close the drift, keeping a 20% stable floor for the next tick.',
      },
    },
  });

  // 2. Router routed leg — USDC → WAVAX on Fuji, marked executed.
  const routed = await db.intent.create({
    data: {
      walletAddress: WALLET,
      fromAgent: 'router',
      status: 'executed',
      createdAt: minsAgo(3),
      payload: {
        kind: 'routed',
        chain: 'avalanche-fuji',
        venue: 'uniswap',
        tokenIn: FUJI_USDC,
        tokenOut: FUJI_WAVAX,
        amountIn: '3540000', // 3.54 USDC (6 decimals)
        notionalUsd: 3.54,
        origin: 'pm',
      },
    },
  });

  // The status endpoint downgrades an 'executed' routed intent to 'failed'
  // unless a matching `intent.executed` event with a real 0x…64 tx hash
  // exists. Insert it so the row stays green + renders the Snowtrace link.
  await db.event.create({
    data: {
      walletAddress: WALLET,
      agent: 'executor',
      kind: 'intent.executed',
      createdAt: minsAgo(2),
      payload: { intentId: routed.id, txHash: TX_HASH },
    },
  });

  // 3. Executor receipt — 'mined' with the same tx.
  await db.intent.create({
    data: {
      walletAddress: WALLET,
      fromAgent: 'executor',
      status: 'executed',
      createdAt: minsAgo(2),
      payload: {
        kind: 'receipt',
        status: 'mined',
        txHash: TX_HASH,
        blockNumber: '38214907',
      },
    },
  });

  console.log('✓ Seeded demo feed for', WALLET);
  console.log('  · PM allocation   ', alloc.id);
  console.log('  · Router routed   ', routed.id, '(USDC → WAVAX, Fuji)');
  console.log('  · Executor receipt  tx', TX_HASH.slice(0, 12) + '…');
  if (process.argv[3]) {
    console.log('  · Using REAL tx hash — Snowtrace links will resolve.');
  } else {
    console.log(
      '  · Placeholder tx hash — Snowtrace links will 404. Pass a real ' +
        'Fuji tx as the 2nd arg to fix.',
    );
  }
  console.log('\nOpen the dashboard — the Agent Feed should now show 3 entries.');
  console.log('Reset with:  npx tsx scripts/clean-feed.ts --apply');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
