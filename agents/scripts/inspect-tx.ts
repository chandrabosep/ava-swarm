// Decode a mainnet tx receipt — confirms whether a KH-executed call
// actually succeeded and where its side effects went.
//
// Run: npx tsx scripts/inspect-tx.ts 0x3da8d4f28bb9f02d8ca4b53248d769a4f452f052f3512607ccd53ac19d184e4e

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import { createPublicClient, decodeEventLog, formatEther, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const TX = process.argv[2] as `0x${string}` | undefined;
if (!TX) {
  console.error('Usage: npx tsx scripts/inspect-tx.ts <0x...>');
  process.exit(1);
}

const wethDepositAbi = parseAbi([
  'event Deposit(address indexed dst, uint256 wad)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

async function main() {
  const c = createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.MAINNET_RPC_URL ?? 'https://ethereum.publicnode.com',
    ),
  });
  const tx = await c.getTransaction({ hash: TX! });
  const receipt = await c.getTransactionReceipt({ hash: TX! });
  console.log(`tx ${TX}\n`);
  console.log(`from:     ${tx.from}`);
  console.log(`to:       ${tx.to}`);
  console.log(`value:    ${formatEther(tx.value)} ETH`);
  console.log(`status:   ${receipt.status} ${receipt.status === 'reverted' ? '⚠️ REVERTED' : '✓'}`);
  console.log(`block:    ${receipt.blockNumber}`);
  console.log(`gas used: ${receipt.gasUsed}`);
  console.log(`logs:     ${receipt.logs.length}`);
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: wethDepositAbi,
        data: log.data,
        topics: log.topics,
      });
      const args = decoded.args as Record<string, unknown>;
      const human =
        decoded.eventName === 'Deposit'
          ? `Deposit dst=${args.dst} wad=${formatEther(args.wad as bigint)} WETH`
          : decoded.eventName === 'Transfer'
            ? `Transfer ${args.from} → ${args.to} value=${args.value}`
            : decoded.eventName;
      console.log(`  ${log.address}: ${human}`);
    } catch {
      console.log(`  ${log.address}: (undecoded)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
