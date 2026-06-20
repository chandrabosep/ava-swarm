// Direct-RPC portfolio reader for Avalanche Fuji.
//
// Alchemy's Portfolio API is unreliable on Fuji (returns phantom balances and
// no prices), which made PM propose against numbers the executor — which
// reads real on-chain balances before swapping — couldn't honour. This reads
// the canonical Fuji RPC for the treasury's actual holdings across the
// Pangolin-liquid universe, so PM, Router, and Executor all see the same
// truth. Prices are testnet fallbacks (overridable via FUJI_PRICE_<SYM>).

import {
  createPublicClient,
  http,
  erc20Abi,
  formatUnits,
  type Address,
} from 'viem';
import { avalancheFuji } from 'viem/chains';

const RPC =
  process.env.RPC_AVALANCHE_FUJI ?? 'https://api.avax-test.network/ext/bc/C/rpc';

interface TokenDef {
  address: Address | null; // null = native AVAX
  decimals: number;
  price: number;
}

function priceFor(sym: string, fallback: number): number {
  const o = process.env[`FUJI_PRICE_${sym}`];
  return o ? parseFloat(o) : fallback;
}

// The Fuji universe the swarm trades (matches router/tokens.ts).
const FUJI_TOKENS: Record<string, TokenDef> = {
  AVAX: { address: null, decimals: 18, price: priceFor('AVAX', 30) },
  WAVAX: {
    address: '0xd00ae08403B9bbb9124bB305C09058E32C39A48c',
    decimals: 18,
    price: priceFor('WAVAX', 30),
  },
  DAI: {
    address: '0x34B6C87bb59Eb37EFe35C8d594a234Cd8C654D50',
    decimals: 18,
    price: priceFor('DAI', 1),
  },
  UNI: {
    address: '0xf4E0A9224e8827dE91050b528F34e2F99C82Fbf6',
    decimals: 18,
    price: priceFor('UNI', 8),
  },
  JOE: {
    address: '0xEa81F6972aDf76765Fd1435E119Acc0Aafc80BeA',
    decimals: 18,
    price: priceFor('JOE', 0.5),
  },
};

const client = createPublicClient({
  chain: avalancheFuji,
  transport: http(RPC),
});

export interface FujiHolding {
  symbol: string;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}

/** Read the wallet's real on-chain holdings across the Fuji universe.
 *  Only non-zero balances are returned. */
export async function readFujiPortfolio(wallet: string): Promise<FujiHolding[]> {
  const addr = wallet as Address;
  const out: FujiHolding[] = [];
  await Promise.all(
    Object.entries(FUJI_TOKENS).map(async ([symbol, t]) => {
      try {
        const raw =
          t.address === null
            ? await client.getBalance({ address: addr })
            : ((await client.readContract({
                address: t.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [addr],
              })) as bigint);
        if (raw <= 0n) return;
        const balance = Number(formatUnits(raw, t.decimals));
        out.push({ symbol, balance, priceUsd: t.price, valueUsd: balance * t.price });
      } catch {
        /* skip unreadable token */
      }
    }),
  );
  out.sort((a, b) => b.valueUsd - a.valueUsd);
  return out;
}
