// Speedrun helper — fan a little Fuji AVAX from the PM wallet out to the
// Router / Executor / ALM service wallets so each can pay gas for its
// ERC-8004 identity registration (and PM for giveFeedback writes).
//
// You only faucet the PM wallet; this script distributes from it.
//
// Run:  npx tsx --env-file=.env scripts/fund-fuji.ts
//
// Idempotent: skips any wallet already above MIN_AVAX.

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';

const RPC = process.env.RPC_AVALANCHE_FUJI ?? 'https://api.avax-test.network/ext/bc/C/rpc';
const MIN_AVAX = parseEther('0.05'); // top up anyone below this
const SEND_AVAX = parseEther('0.1'); // amount to send when topping up

function acct(name: string) {
  const k = process.env[`${name}_SERVICE_PRIVKEY`];
  if (!k) throw new Error(`${name}_SERVICE_PRIVKEY not set`);
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`);
}

async function main() {
  const pub = createPublicClient({ chain: avalancheFuji, transport: http(RPC) });
  const pm = acct('PM');
  const targets: Array<{ name: string; address: Address }> = [
    { name: 'ROUTER', address: acct('ROUTER').address },
    { name: 'EXECUTOR', address: acct('EXECUTOR').address },
    { name: 'ALM', address: acct('ALM').address },
  ];

  const pmBal = await pub.getBalance({ address: pm.address });
  console.log(`PM ${pm.address}  AVAX=${formatEther(pmBal)}`);
  if (pmBal === 0n) {
    console.error('\n❌ PM wallet has 0 AVAX. Faucet it first: https://faucet.avax.network/ (Fuji C-Chain)');
    process.exit(1);
  }

  const wallet = createWalletClient({ account: pm, chain: avalancheFuji, transport: http(RPC) });

  for (const t of targets) {
    const bal = await pub.getBalance({ address: t.address });
    if (bal >= MIN_AVAX) {
      console.log(`✅ ${t.name.padEnd(8)} ${t.address}  AVAX=${formatEther(bal)} (sufficient, skip)`);
      continue;
    }
    process.stdout.write(`→  ${t.name.padEnd(8)} ${t.address}  AVAX=${formatEther(bal)} — sending ${formatEther(SEND_AVAX)} … `);
    const hash = await wallet.sendTransaction({ to: t.address, value: SEND_AVAX });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`done  ${hash}`);
  }
  console.log('\nDistribution complete.');
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
