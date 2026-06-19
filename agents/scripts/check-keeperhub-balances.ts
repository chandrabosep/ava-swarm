// Read the KeeperHub wallet's mainnet balances for ETH and WETH so we
// can diagnose STF errors. STF = WETH.transferFrom failed = wallet
// doesn't actually have the WETH the swap is trying to spend.
//
// Resolves the actual KH wallet via get_wallet_integration MCP
// (previous version hardcoded a wrong-but-similar-looking address).
//
// Run: npx tsx scripts/check-keeperhub-balances.ts

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  erc20Abi,
  type Address,
} from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import { getKeeperhubWalletAddress } from '../executor/src/onchain.js';

interface ChainCfg {
  name: string;
  chain: typeof mainnet | typeof sepolia | typeof base | typeof baseSepolia;
  rpc: string;
  weth: Address;
  usdc: Address;
  routers: { name: string; addr: Address }[];
}

const CHAINS: ChainCfg[] = [
  {
    name: 'mainnet',
    chain: mainnet,
    rpc: process.env.MAINNET_RPC_URL ?? 'https://ethereum.publicnode.com',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    routers: [
      { name: 'SwapRouter ', addr: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
      { name: 'SwapRouter02', addr: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' },
      { name: 'UniversalRtr', addr: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af' },
    ],
  },
  {
    name: 'sepolia',
    chain: sepolia,
    rpc:
      process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia.publicnode.com',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    routers: [
      // Uniswap V3 on Sepolia — addresses from Uniswap's official deployments.
      { name: 'SwapRouter02', addr: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E' },
      { name: 'UniversalRtr', addr: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b' },
    ],
  },
  {
    name: 'base-sepolia',
    chain: baseSepolia,
    rpc:
      process.env.BASE_SEPOLIA_RPC_URL ??
      'https://base-sepolia.publicnode.com',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    routers: [
      { name: 'SwapRouter02', addr: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4' },
      { name: 'UniversalRtr', addr: '0x95273d871c8156636e114b63797d78D7E1720d81' },
    ],
  },
];

async function probeChain(cfg: ChainCfg, wallet: Address): Promise<void> {
  const c = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  console.log(`\n=== ${cfg.name.toUpperCase()} ===`);
  try {
    const [eth, weth, usdc] = await Promise.all([
      c.getBalance({ address: wallet }),
      c.readContract({
        address: cfg.weth,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      }),
      c.readContract({
        address: cfg.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      }),
    ]);
    console.log(`  ETH:  ${formatEther(eth)}`);
    console.log(`  WETH: ${formatEther(weth as bigint)}`);
    console.log(`  USDC: ${formatUnits(usdc as bigint, 6)}`);

    const allowances = await Promise.all(
      cfg.routers.map((r) =>
        c.readContract({
          address: cfg.weth,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [wallet, r.addr],
        }),
      ),
    );
    console.log(`  WETH allowances:`);
    for (let i = 0; i < cfg.routers.length; i++) {
      const a = allowances[i] as bigint;
      const human =
        a > 10n ** 30n ? '∞ (max)' : a === 0n ? '0' : formatEther(a);
      console.log(`    → ${cfg.routers[i].name}: ${human}`);
    }
  } catch (err) {
    console.log(
      `  (probe failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function main() {
  const wallet = await getKeeperhubWalletAddress();
  console.log(`Resolved KH wallet via MCP: ${wallet}`);

  for (const cfg of CHAINS) {
    await probeChain(cfg, wallet);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
