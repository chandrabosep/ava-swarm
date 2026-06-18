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
import { baseSepolia, mainnet, sepolia } from 'viem/chains';

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
  // Try mainnet, sepolia, base-sepolia in order — first one that
  // returns a receipt wins. Tells us definitively which chain a
  // KH-emitted tx hash actually landed on.
  const candidates = [
    {
      name: 'mainnet',
      etherscan: 'https://etherscan.io',
      client: createPublicClient({
        chain: mainnet,
        transport: http(
          process.env.MAINNET_RPC_URL ?? 'https://ethereum.publicnode.com',
        ),
      }),
    },
    {
      name: 'sepolia',
      etherscan: 'https://sepolia.etherscan.io',
      client: createPublicClient({
        chain: sepolia,
        transport: http(
          process.env.SEPOLIA_RPC_URL ??
            'https://ethereum-sepolia.publicnode.com',
        ),
      }),
    },
    {
      name: 'base-sepolia',
      etherscan: 'https://sepolia.basescan.org',
      client: createPublicClient({
        chain: baseSepolia,
        transport: http(
          process.env.BASE_SEPOLIA_RPC_URL ??
            'https://base-sepolia.publicnode.com',
        ),
      }),
    },
  ];

  let tx: Awaited<ReturnType<(typeof candidates)[0]['client']['getTransaction']>> | null = null;
  let receipt: Awaited<
    ReturnType<(typeof candidates)[0]['client']['getTransactionReceipt']>
  > | null = null;
  let landed: (typeof candidates)[number] | null = null;

  for (const cand of candidates) {
    try {
      tx = await cand.client.getTransaction({ hash: TX! });
      receipt = await cand.client.getTransactionReceipt({ hash: TX! });
      landed = cand;
      break;
    } catch {
      // try next
    }
  }

  if (!tx || !receipt || !landed) {
    console.log(`tx ${TX} NOT FOUND on mainnet, sepolia, or base-sepolia`);
    return;
  }

  console.log(`tx ${TX}`);
  console.log(`chain:    ${landed.name.toUpperCase()}  ← ${landed.etherscan}/tx/${TX}\n`);
  const c = landed.client;
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
