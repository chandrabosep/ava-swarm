// Real swap execution on Avalanche via Pangolin (Uniswap-V2 fork).
//
// The executor's own service key IS the treasury — it holds AVAX + tokens
// on Fuji and swaps them on-chain. Pangolin is the venue (verified liquid on
// Fuji: WAVAX paired with DAI/UNI/JOE/PNG). Native AVAX uses the router's
// AVAX-specific entrypoints; ERC-20 legs route through WAVAX.
//
// Flow per swap: clamp amount to balance (keep a gas buffer for native) →
// approve router if needed → getAmountsOut → apply slippage → swap → return
// the real tx hash (resolvable on Snowtrace).

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';

const FUJI_RPC =
  process.env.RPC_AVALANCHE_FUJI ?? 'https://api.avax-test.network/ext/bc/C/rpc';
const PANGOLIN_ROUTER = getAddress(
  process.env.PANGOLIN_ROUTER ?? '0x2D99ABD9008Dc933ff5c0CD271B88309593aB921',
);
const WAVAX = getAddress('0xd00ae08403B9bbb9124bB305C09058E32C39A48c');
const NATIVE = '0x0000000000000000000000000000000000000000';
const MAX_UINT = (1n << 256n) - 1n;
/** Native AVAX kept back for gas when selling AVAX (0.05). */
const GAS_BUFFER_WEI = 50_000_000_000_000_000n;
const SLIPPAGE_BPS = BigInt(process.env.PANGOLIN_SLIPPAGE_BPS ?? '300'); // 3%

const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function swapExactAVAXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForAVAX(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
]);
const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

const pub = createPublicClient({
  chain: avalancheFuji,
  transport: http(FUJI_RPC),
});

function treasuryAccount() {
  const k = process.env.EXECUTOR_SERVICE_PRIVKEY;
  if (!k) throw new Error('EXECUTOR_SERVICE_PRIVKEY not set');
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex);
}

/** Public-RPC client for receipt confirmation. */
export function fujiClient() {
  return pub;
}

const isNative = (a: string): boolean => a.toLowerCase() === NATIVE;

/**
 * Execute a real swap on Pangolin from the treasury wallet. Returns the
 * submitted tx hash; caller confirms the receipt.
 */
export async function swapOnPangolin(opts: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}): Promise<Hex> {
  const account = treasuryAccount();
  const to = account.address;
  const wallet = createWalletClient({
    account,
    chain: avalancheFuji,
    transport: http(FUJI_RPC),
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const inAddr = isNative(opts.tokenIn) ? WAVAX : getAddress(opts.tokenIn);
  const outAddr = isNative(opts.tokenOut) ? WAVAX : getAddress(opts.tokenOut);
  if (inAddr === outAddr) throw new Error('tokenIn equals tokenOut');
  // Route directly if one leg is WAVAX, else hop through WAVAX.
  const path: Address[] =
    inAddr === WAVAX || outAddr === WAVAX ? [inAddr, outAddr] : [inAddr, WAVAX, outAddr];

  let amountIn = opts.amountIn;

  // Clamp to available balance.
  if (isNative(opts.tokenIn)) {
    const bal = await pub.getBalance({ address: to });
    const spendable = bal > GAS_BUFFER_WEI ? bal - GAS_BUFFER_WEI : 0n;
    if (amountIn > spendable) amountIn = spendable;
    if (amountIn <= 0n) throw new Error('insufficient AVAX (after gas buffer)');
  } else {
    const bal = (await pub.readContract({
      address: inAddr,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [to],
    })) as bigint;
    if (amountIn > bal) amountIn = bal;
    if (amountIn <= 0n) throw new Error('insufficient token balance');
    // Approve router once (max) if allowance is short.
    const allowance = (await pub.readContract({
      address: inAddr,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [to, PANGOLIN_ROUTER],
    })) as bigint;
    if (allowance < amountIn) {
      const approveHash = await wallet.writeContract({
        address: inAddr,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [PANGOLIN_ROUTER, MAX_UINT],
      });
      await pub.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  // Quote → minOut with slippage.
  const amounts = (await pub.readContract({
    address: PANGOLIN_ROUTER,
    abi: ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [amountIn, path],
  })) as bigint[];
  const expectedOut = amounts[amounts.length - 1];
  const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (minOut <= 0n) throw new Error('no liquidity / zero quote for path');

  if (isNative(opts.tokenIn)) {
    return wallet.writeContract({
      address: PANGOLIN_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactAVAXForTokens',
      args: [minOut, path, to, deadline],
      value: amountIn,
    });
  }
  if (isNative(opts.tokenOut)) {
    return wallet.writeContract({
      address: PANGOLIN_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForAVAX',
      args: [amountIn, minOut, path, to, deadline],
    });
  }
  return wallet.writeContract({
    address: PANGOLIN_ROUTER,
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, minOut, path, to, deadline],
  });
}
