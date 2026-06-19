// Direct read-side onchain helpers for the KeeperHub-managed wallet.
//
// KH abstracts execution behind its MCP, but every swap depends on
// preconditions we need to verify ourselves before submitting:
//   - the wallet holds enough WETH for the swap's amountIn
//   - SwapRouter02 has a non-zero allowance for that WETH
//   - the wallet has enough native ETH to cover an on-the-fly wrap
//
// We use viem against a public RPC for these reads — no signing, no KH
// roundtrip. Writes (wrap, approve, swap) still go through KH so the
// integration-managed key signs them.
//
// The KH wallet address is fetched once via the `get_wallet_integration`
// MCP tool and cached for the lifetime of the executor process.

import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';

import { callKeeperhubTool } from './keeperhub-mcp.js';

export type ChainName =
  | 'mainnet'
  | 'base'
  | 'unichain'
  | 'sepolia'
  | 'base-sepolia';

export const WETH_ADDRESS: Record<ChainName, Address> = {
  mainnet: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  unichain: '0x4200000000000000000000000000000000000006',
  sepolia: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  'base-sepolia': '0x4200000000000000000000000000000000000006',
};

/** Uniswap V3 SwapRouter02 — chain-specific. The address `0xE592...`
 *  that's "the same on every chain" is actually the legacy V3
 *  SwapRouter (V1), not SwapRouter02. On Sepolia / Base Sepolia /
 *  Unichain those legacy contracts don't exist, so an approval there
 *  is a no-op and any swap STFs.
 *
 *  Source: https://docs.uniswap.org/contracts/v3/reference/deployments
 *  Override per chain via UNISWAP_SWAP_ROUTER_<CHAIN>.
 */
export const SWAP_ROUTER_02_BY_CHAIN: Record<ChainName, Address> = {
  mainnet: (process.env.UNISWAP_SWAP_ROUTER_MAINNET ??
    '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45') as Address,
  base: (process.env.UNISWAP_SWAP_ROUTER_BASE ??
    '0x2626664c2603336E57B271c5C0b26F421741e481') as Address,
  unichain: (process.env.UNISWAP_SWAP_ROUTER_UNICHAIN ??
    '0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C') as Address,
  sepolia: (process.env.UNISWAP_SWAP_ROUTER_SEPOLIA ??
    '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E') as Address,
  'base-sepolia': (process.env.UNISWAP_SWAP_ROUTER_BASE_SEPOLIA ??
    '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4') as Address,
};

/** Resolve the SwapRouter02 address for a chain. Throws if unknown. */
export function swapRouterFor(chain: ChainName): Address {
  const addr = SWAP_ROUTER_02_BY_CHAIN[chain];
  if (!addr) throw new Error(`No SwapRouter02 configured for chain ${chain}`);
  return addr;
}

/** @deprecated Use swapRouterFor(chain) instead. Kept for back-compat
 *  with call sites that haven't migrated; defaults to mainnet. */
export const SWAP_ROUTER_02: Address = SWAP_ROUTER_02_BY_CHAIN.mainnet;

/** Public RPC per chain — overridable via env. */
function rpcUrl(chain: ChainName): string {
  switch (chain) {
    case 'mainnet':
      return process.env.MAINNET_RPC_URL ?? 'https://ethereum.publicnode.com';
    case 'base':
      return process.env.BASE_RPC_URL ?? 'https://base.publicnode.com';
    case 'unichain':
      return (
        process.env.UNICHAIN_RPC_URL ?? 'https://unichain.publicnode.com'
      );
    case 'sepolia':
      return (
        process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia.publicnode.com'
      );
    case 'base-sepolia':
      return (
        process.env.BASE_SEPOLIA_RPC_URL ?? 'https://base-sepolia.publicnode.com'
      );
  }
}

function chainFor(chain: ChainName) {
  if (chain === 'mainnet') return mainnet;
  if (chain === 'base') return base;
  if (chain === 'sepolia') return sepolia;
  if (chain === 'base-sepolia') return baseSepolia;
  // viem doesn't ship a unichain chain spec — minimal stub is fine for
  // read-only RPC calls (chainId is only checked on write paths).
  return { ...mainnet, id: 130 };
}

function clientFor(chain: ChainName) {
  return createPublicClient({
    chain: chainFor(chain),
    transport: http(rpcUrl(chain)),
  });
}

/**
 * Public-RPC viem client for the given executor chain. Used by
 * post-execution receipt verification — KeeperHub returning
 * `status=mined` with a hash isn't sufficient; we have to confirm the
 * transaction actually succeeded on-chain (status === 'success') before
 * marking the intent executed.
 */
export function publicClientForChain(chain: ChainName) {
  return clientFor(chain);
}

let cachedKhWallet: Address | null = null;

/**
 * Fetch the KeeperHub-managed wallet address for the configured
 * integration. KH exposes this via `get_wallet_integration`. Cached
 * for the rest of the process.
 */
export async function getKeeperhubWalletAddress(): Promise<Address> {
  if (cachedKhWallet) return cachedKhWallet;
  const integrationId = process.env.KEEPERHUB_INTEGRATION_ID;
  if (!integrationId) {
    throw new Error('KEEPERHUB_INTEGRATION_ID not set');
  }
  // KH MCP naming is inconsistent across tools: execute_contract_call
  // takes snake_case (`integration_id`), get_wallet_integration takes
  // camelCase (`integrationId`). Verified against the live tool's
  // input schema — see Zod validation error message.
  const raw = await callKeeperhubTool('get_wallet_integration', {
    integrationId,
  });
  // unwrap MCP shape — the tool returns the integration record;
  // exact field name varies, so look at common candidates.
  const data = unwrapMcp(raw) as Record<string, unknown>;
  const candidates = [
    data?.address,
    data?.walletAddress,
    data?.publicKey,
    (data?.wallet as Record<string, unknown> | undefined)?.address,
  ];
  const found = candidates.find(
    (v): v is string => typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v),
  );
  if (!found) {
    throw new Error(
      `KeeperHub get_wallet_integration: no address in response. Raw: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  cachedKhWallet = found as Address;
  return cachedKhWallet;
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function unwrapMcp(res: unknown): unknown {
  const r = res as McpToolResult;
  if (r?.isError) {
    const text = r.content?.[0]?.text ?? 'unknown error';
    throw new Error(`KeeperHub MCP error: ${text}`);
  }
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const text = r?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

/** Native ETH balance (wei). */
export async function getEthBalance(
  chain: ChainName,
  who?: Address,
): Promise<bigint> {
  const addr = who ?? (await getKeeperhubWalletAddress());
  return clientFor(chain).getBalance({ address: addr });
}

/** ERC-20 balance for an address. */
export async function getErc20Balance(
  chain: ChainName,
  token: Address,
  who?: Address,
): Promise<bigint> {
  const addr = who ?? (await getKeeperhubWalletAddress());
  return (await clientFor(chain).readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  })) as bigint;
}

/** ERC-20 allowance from owner to spender. */
export async function getErc20Allowance(
  chain: ChainName,
  token: Address,
  spender: Address,
  owner?: Address,
): Promise<bigint> {
  const ownerAddr = owner ?? (await getKeeperhubWalletAddress());
  return (await clientFor(chain).readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ownerAddr, spender],
  })) as bigint;
}
