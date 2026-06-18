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
import { base, mainnet } from 'viem/chains';

import { callKeeperhubTool } from './keeperhub-mcp.js';

export type ChainName = 'mainnet' | 'base' | 'unichain';

export const WETH_ADDRESS: Record<ChainName, Address> = {
  mainnet: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  unichain: '0x4200000000000000000000000000000000000006',
};

/** Uniswap V3 SwapRouter02 (immutable, same on every supported chain). */
export const SWAP_ROUTER_02: Address =
  '0xE592427A0AEce92De3Edee1F18E0157C05861564';

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
  }
}

function chainFor(chain: ChainName) {
  if (chain === 'mainnet') return mainnet;
  if (chain === 'base') return base;
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
