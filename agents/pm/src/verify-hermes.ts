// One-shot verifier: seed swarm_settings, call the same resolveLlm() PM
// uses each tick, print what it picks. Doesn't hit any LLM — just confirms
// the DB-read path picks up the row the extension's settings card writes.
//
//   npx tsx --env-file=../.env src/verify-hermes.ts
//
// Cleans the row back to disabled / no key when done so the next real PM
// boot starts from a known state.

import { db } from '@swarm/shared';
import { resolveLlm } from './decide.js';

function maskKey(k: string): string {
  if (k.length <= 4) return '****';
  return `••••${k.slice(-4)}`;
}

async function step(label: string, fn: () => Promise<void>) {
  console.log(`\n--- ${label} ---`);
  await fn();
}

async function main() {
  await step('1. clean slate', async () => {
    await db().swarmSettings.upsert({
      where: { id: 'global' },
      update: {
        hermesEnabled: false,
        hermesApiKey: null,
        hermesModel: null,
        hermesBaseUrl: null,
        hermesSkill: null,
      },
      create: { id: 'global', hermesEnabled: false },
    });
    const r = await resolveLlm();
    console.log('resolved:', { ...r, apiKey: maskKey(r.apiKey) });
    if (r.provider !== 'groq') {
      throw new Error(`expected groq, got ${r.provider}`);
    }
    console.log('OK: empty row → groq fallback');
  });

  await step('2. seed Hermes row (enabled + key + skill)', async () => {
    await db().swarmSettings.update({
      where: { id: 'global' },
      data: {
        hermesEnabled: true,
        hermesApiKey: 'sk-verify-CAFEBABE9999',
        hermesModel: 'Hermes-4-405B',
        hermesBaseUrl: 'https://inference-api.nousresearch.com/v1',
        hermesSkill: 'verify-test: prefer USDC on red days',
      },
    });
    const r = await resolveLlm();
    console.log('resolved:', { ...r, apiKey: maskKey(r.apiKey) });
    if (r.provider !== 'hermes') {
      throw new Error(`expected hermes, got ${r.provider}`);
    }
    if (!r.skillSuffix?.includes('verify-test')) {
      throw new Error('skillSuffix did not flow through');
    }
    if (r.baseURL !== 'https://inference-api.nousresearch.com/v1') {
      throw new Error(`baseURL mismatch: ${r.baseURL}`);
    }
    if (r.model !== 'Hermes-4-405B') {
      throw new Error(`model mismatch: ${r.model}`);
    }
    console.log('OK: row → hermes overrides');
  });

  await step('3. disabled flag wins (key still on file)', async () => {
    await db().swarmSettings.update({
      where: { id: 'global' },
      data: { hermesEnabled: false },
    });
    const r = await resolveLlm();
    console.log('resolved provider:', r.provider, 'skillSuffix:', r.skillSuffix);
    if (r.provider !== 'groq') {
      throw new Error(`expected groq when disabled, got ${r.provider}`);
    }
    if (r.skillSuffix !== null) {
      throw new Error(`skillSuffix should be null when disabled, got "${r.skillSuffix}"`);
    }
    console.log('OK: enabled=false → falls back to groq even with key on file');
  });

  await step('4. clean up (clear test key)', async () => {
    await db().swarmSettings.update({
      where: { id: 'global' },
      data: {
        hermesEnabled: false,
        hermesApiKey: null,
        hermesModel: null,
        hermesBaseUrl: null,
        hermesSkill: null,
      },
    });
    console.log('OK: row reset');
  });

  console.log('\nALL CHECKS PASSED');
  // db().$disconnect() exits the prisma pool so the script can return.
  await db().$disconnect();
}

main().catch((err: unknown) => {
  console.error('verify failed:', err);
  void db().$disconnect();
  process.exit(1);
});
