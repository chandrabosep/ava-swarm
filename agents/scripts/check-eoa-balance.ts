// Probe what Alchemy returns for the user's EOA — same call PM makes
// when USE_TESTNET=true. If this returns empty, PM will see an empty
// portfolio and skip; the fix is to fund the EOA on Sepolia/Base Sepolia.
//
// Run: npx tsx scripts/check-eoa-balance.ts
//      npx tsx scripts/check-eoa-balance.ts 0x<some-other-address>

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { fetchAlchemyTokens } from '@swarm/shared';

const ADDR =
  (process.argv[2] as string | undefined) ??
  '0x56b586d5476efa2d1f2375904be62833c8c17012';

async function main() {
  console.log(`Probing Alchemy for ${ADDR} on networks: ${process.env.ALCHEMY_NETWORKS}\n`);
  const tokens = await fetchAlchemyTokens(ADDR);
  console.log(`Total tokens returned: ${tokens.length}`);
  const nonZero = tokens.filter((t) => {
    try {
      return BigInt(t.tokenBalance) > 0n;
    } catch {
      return false;
    }
  });
  console.log(`Non-zero balances: ${nonZero.length}\n`);
  for (const t of nonZero) {
    const dec = t.tokenMetadata?.decimals ?? 18;
    const sym = t.tokenMetadata?.symbol ?? (t.tokenAddress === null ? 'NATIVE' : '?');
    const raw = BigInt(t.tokenBalance);
    const human = Number(raw) / 10 ** dec;
    const usd = t.tokenPrices?.find((p) => p.currency === 'usd')?.value;
    console.log(
      `  [${t.network}]  ${sym}  ${human.toFixed(6)}  ${usd ? `$${(human * parseFloat(usd)).toFixed(4)}` : '(no price)'}`,
    );
  }
  if (nonZero.length === 0) {
    console.log('⚠️  EOA has zero balance on every queried testnet.');
    console.log('   Send Sepolia ETH from a faucet to:');
    console.log(`   ${ADDR}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
