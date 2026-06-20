// Speedrun readiness + verification check.
//
// Run:  npx tsx --env-file=.env scripts/verify-speedrun.ts
//
// Reports everything the agents-hire-agents (x402 + ERC-8004) demo needs:
//   - Fuji AVAX/USDC balances of the 4 service wallets
//   - ERC-8004 registry addresses configured + actually deployed (have code)
//   - x402 facilitator reachable
// Use it before booting (are we ready?) and after (did funds/registries land?).

import { createPublicClient, http, formatEther, erc20Abi, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';

const RPC = process.env.RPC_AVALANCHE_FUJI ?? 'https://api.avax-test.network/ext/bc/C/rpc';
const USDC = (process.env.USDC_ADDRESS ?? '0x5425890298aed601595a70AB815c96711a31Bc65') as Address;
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? 'https://facilitator.ultravioletadao.xyz';

function addr(name: string): Address {
  const k = process.env[`${name}_SERVICE_PRIVKEY`];
  if (!k) throw new Error(`${name}_SERVICE_PRIVKEY not set`);
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`).address;
}

async function main() {
  const pub = createPublicClient({ chain: avalancheFuji, transport: http(RPC) });
  let ok = true;

  console.log('=== Fuji wallet balances ===');
  const roles = ['PM', 'ROUTER', 'EXECUTOR', 'ALM'] as const;
  for (const r of roles) {
    const a = addr(r);
    const avax = await pub.getBalance({ address: a });
    let usdc = 0n;
    try {
      usdc = (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })) as bigint;
    } catch { /* ignore */ }
    const needAvax = avax < 10n ** 16n; // < 0.01
    const needUsdc = r === 'PM' && usdc === 0n;
    if (needAvax || needUsdc) ok = false;
    console.log(
      `${needAvax || needUsdc ? '⚠️ ' : '✅'} ${r.padEnd(8)} ${a}  AVAX=${Number(formatEther(avax)).toFixed(4)}` +
        (r === 'PM' ? `  USDC=${(Number(usdc) / 1e6).toFixed(2)}` : ''),
    );
  }
  console.log('  (PM needs AVAX + USDC; others need a little AVAX for ERC-8004 writes)');

  console.log('\n=== ERC-8004 registries ===');
  for (const [label, env] of [
    ['Identity  ', 'ERC8004_IDENTITY_ADDRESS'],
    ['Reputation', 'ERC8004_REPUTATION_ADDRESS'],
  ] as const) {
    const v = process.env[env];
    if (!v) {
      ok = false;
      console.log(`❌ ${label}  unset — run the DeployErc8004 forge script`);
      continue;
    }
    const code = await pub.getBytecode({ address: v as Address });
    const has = !!code && code !== '0x';
    if (!has) ok = false;
    console.log(`${has ? '✅' : '❌'} ${label}  ${v}  ${has ? `(${(code!.length - 2) / 2} bytes)` : '(NO CODE at address!)'}`);
  }

  console.log('\n=== x402 facilitator ===');
  try {
    const res = await fetch(`${FACILITATOR}/supported`, { signal: AbortSignal.timeout(8000) });
    console.log(`${res.ok ? '✅' : '⚠️ '} ${FACILITATOR}/supported -> HTTP ${res.status}`);
    if (!res.ok) ok = false;
  } catch (e: any) {
    ok = false;
    console.log(`❌ ${FACILITATOR} unreachable: ${e.message}`);
  }

  console.log(`\n${ok ? '✅ READY — boot the swarm and watch the hire loop.' : '⛔ NOT READY — resolve the ⚠️/❌ items above.'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
