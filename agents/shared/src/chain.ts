// Onchain reads: subscribe to Smart Sessions events, look up session state.
//
// This is the registry for "which users does this agent serve?" An agent's
// service identity is a fixed pubkey baked into its env. When a Safe owner
// signs a session-grant onchain, the Smart Sessions module emits an event
// containing that pubkey — agents listen, recognize themselves, and
// auto-enroll the user in their DB.
//
// For Phase B-1 we provide a polling poller (cheap, simple, works behind
// any RPC). A websocket variant can swap in later without changing the
// caller-facing API.

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { mainnet, base, unichain } from 'viem/chains';

import { env } from './env.js';
import type { SupportedChain } from './types.js';

const VIEM_CHAIN = { mainnet, base, unichain } as const;

// Return type intentionally inferred — viem's exported `PublicClient`
// alias and the actual return of `createPublicClient(...)` are two
// different generic instantiations with the same display name (TS
// error 2719). Letting inference do the work avoids the conflict and
// gives callers a tighter type.
export function publicClientFor(chain: SupportedChain) {
  return createPublicClient({
    chain: VIEM_CHAIN[chain],
    transport: http(env.rpc(chain)),
  });
}

// Minimal Smart Sessions event ABI. Real ABI is larger; we only watch the
// session-enable event for tenant onboarding.
export const SMART_SESSIONS_EVENTS = parseAbi([
  'event SessionEnabled(address indexed safe, address indexed sessionKey, bytes32 indexed policyHash, uint256 validUntil)',
  'event SessionRevoked(address indexed safe, address indexed sessionKey)',
]);

export interface SessionEnabledEvent {
  chain: SupportedChain;
  safe: Address;
  sessionKey: Address;
  policyHash: Hex;
  validUntil: number;
  blockNumber: bigint;
  txHash: Hex;
}

export interface ChainPoller {
  stop(): void;
}

/**
 * Poll for new SessionEnabled events on a given chain. Calls `onEvent` for
 * each new event since the last poll. Tracks block cursor in memory; for
 * production-grade durability we'd persist the cursor in Postgres.
 */
export function pollSessionEvents(
  chain: SupportedChain,
  onEvent: (e: SessionEnabledEvent) => Promise<void> | void,
  /** Filter to only events whose sessionKey matches this. Optional. */
  filter?: { sessionKey?: Address },
  intervalMs: number = 15_000,
): ChainPoller {
  const client = publicClientFor(chain);
  let stopped = false;
  let cursor: bigint | undefined;

  (async () => {
    cursor = await client.getBlockNumber();
    while (!stopped) {
      try {
        const head = await client.getBlockNumber();
        if (cursor !== undefined && head > cursor) {
          const logs = await client.getLogs({
            event: SMART_SESSIONS_EVENTS[0],
            fromBlock: cursor + 1n,
            toBlock: head,
            args: filter?.sessionKey ? { sessionKey: filter.sessionKey } : undefined,
          });
          for (const log of logs) {
            await onEvent({
              chain,
              safe: log.args.safe as Address,
              sessionKey: log.args.sessionKey as Address,
              policyHash: log.args.policyHash as Hex,
              validUntil: Number(log.args.validUntil ?? 0n),
              blockNumber: log.blockNumber ?? 0n,
              txHash: log.transactionHash ?? ('0x' as Hex),
            });
          }
          cursor = head;
        }
      } catch (err) {
        // Logged at the agent level — don't kill the poller for transient RPC errors.
        console.warn(`[chain:${chain}] poll error`, err);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  return {
    stop() {
      stopped = true;
    },
  };
}
