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

import { createPublicClient, formatEther, formatUnits, http, erc20Abi } from 'viem';
import { mainnet } from 'viem/chains';
import { getKeeperhubWalletAddress } from '../executor/src/onchain.js';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const SR02_OLD = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const;
const SR02_NEW = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const;
// Uniswap V3 SwapRouter (the one V3 frontend uses) — separate from the two above.
const SR_V3 = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const;
// Universal Router (Uniswap's preferred entry-point for V3+V4 + permit).
const UNIVERSAL_ROUTER = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af' as const;

async function main() {
  const rpc = process.env.MAINNET_RPC_URL ?? 'https://ethereum.publicnode.com';
  const c = createPublicClient({ chain: mainnet, transport: http(rpc) });

  const wallet = await getKeeperhubWalletAddress();
  console.log(`Resolved KH wallet via MCP: ${wallet}\n`);

  const [eth, wethBal, usdcBal, allowSrOld, allowSrNew, allowUR] = await Promise.all([
    c.getBalance({ address: wallet }),
    c.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    c.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    c.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [wallet, SR02_OLD] }),
    c.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [wallet, SR02_NEW] }),
    c.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [wallet, UNIVERSAL_ROUTER] }),
  ]);

  console.log(`Balances:`);
  console.log(`  ETH:  ${formatEther(eth)}`);
  console.log(`  WETH: ${formatEther(wethBal as bigint)}`);
  console.log(`  USDC: ${formatUnits(usdcBal as bigint, 6)}\n`);
  console.log(`WETH allowances (which router does KH actually use?):`);
  console.log(`  → SwapRouter   (0xE592…1564): ${formatEther(allowSrOld as bigint)}`);
  console.log(`  → SwapRouter02 (0x68b3…Fc45): ${formatEther(allowSrNew as bigint)}`);
  console.log(`  → UniversalRtr (0x66a9…D8Af): ${formatEther(allowUR as bigint)}\n`);

  const wethEth = parseFloat(formatEther(wethBal as bigint));
  const sumAllow =
    Number(allowSrOld as bigint) +
    Number(allowSrNew as bigint) +
    Number(allowUR as bigint);
  if (wethEth < 0.0005) {
    console.log(`⚠️  WETH balance < 0.0005 — wrap-on-the-fly will need to top up.`);
  } else {
    console.log(`✓ WETH balance ${wethEth} is enough for typical demo swaps.`);
  }
  if (sumAllow === 0) {
    console.log(`⚠️  ZERO allowance on every router candidate.`);
    console.log(`   Whichever one KH uses internally needs a fresh approve.`);
  } else {
    const which =
      (allowSrOld as bigint) > 0n
        ? 'SwapRouter'
        : (allowSrNew as bigint) > 0n
          ? 'SwapRouter02'
          : 'UniversalRouter';
    console.log(`✓ KH appears to use: ${which} (non-zero WETH allowance there).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
