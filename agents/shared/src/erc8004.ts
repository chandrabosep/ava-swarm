// ERC-8004 — trustless-agent identity + reputation, on Avalanche.
//
// Speedrun: Agentic Payments. Two registries deployed by
// contracts/script/DeployErc8004.s.sol:
//   - IdentityRegistry   : each agent is an ERC-721; tokenId == agentId.
//   - ReputationRegistry : clients leave feedback; anyone reads the summary.
//
// The lead "buyer" agent (PM) reads `getReputation` to pick whom to hire and
// calls `giveFeedback` after a paid x402 job. Sellers register an identity at
// boot so every payment traces back to a known agent, not an anonymous wallet.
//
// All writes are non-fatal: if the registries aren't configured or the RPC is
// down, the swarm runs in degraded mode (payments still settle, just without
// reputation gating). This mirrors how boot.ts treats AXL.

import {
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { avalanche, avalancheFuji } from 'viem/chains';

import { env } from './env.js';
import { serviceAccount } from './keys.js';
import type { AgentRole } from './db.js';
import type { Logger } from './log.js';
import { publicClientFor } from './chain.js';

export const IDENTITY_ABI = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string agentURI)',
  'function totalAgents() view returns (uint256)',
  'function exists(uint256 agentId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)',
]);

export const REPUTATION_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, uint8 score, bytes32 tag, string uri) returns (uint256 index)',
  'function getSummary(uint256 agentId) view returns (uint64 count, uint64 averageScore)',
  'function feedbackCount(uint256 agentId) view returns (uint256)',
  'event FeedbackGiven(uint256 indexed agentId, address indexed client, uint8 score, bytes32 indexed tag, uint256 index)',
]);

const VIEM_DEMO_CHAIN = {
  avalanche,
  'avalanche-fuji': avalancheFuji,
} as const;

function demoChain() {
  return env.demoChain();
}

function identityAddress(): Address | null {
  const a = env.erc8004Identity();
  return a ? (a as Address) : null;
}

function reputationAddress(): Address | null {
  const a = env.erc8004Reputation();
  return a ? (a as Address) : null;
}

/** True when both registries are configured — the reputation-aware path. */
export function erc8004Enabled(): boolean {
  return identityAddress() !== null && reputationAddress() !== null;
}

function walletFor(role: AgentRole) {
  const chain = demoChain();
  return createWalletClient({
    account: serviceAccount(role),
    chain: VIEM_DEMO_CHAIN[chain],
    transport: http(env.rpc(chain)),
  });
}

/**
 * A compact agent "card" stored as the ERC-8004 agentURI. In production this
 * would be an IPFS/HTTPS JSON; for the demo we inline it as a data URI so no
 * hosting is required.
 */
function agentCardUri(role: AgentRole, address: Address): string {
  const card = {
    name: `DefiSwarm-${role.toUpperCase()}`,
    role,
    address,
    description:
      role === 'pm'
        ? 'Lead agent: splits jobs and hires specialists via x402.'
        : role === 'router'
          ? 'Specialist: sells route/quote analysis per x402 call.'
          : role === 'executor'
            ? 'Specialist: sells trade risk checks per x402 call.'
            : 'Specialist: sells liquidity/strategy analysis per x402 call.',
    protocols: ['x402', 'erc-8004'],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(card))}`;
}

export interface ReputationSummary {
  agentId: number;
  count: number;
  /** Mean score 0..100. Defaults to a neutral 50 when there's no feedback yet. */
  avgScore: number;
}

/**
 * Ensure this agent has an on-chain ERC-8004 identity, returning its agentId.
 *
 * Resolution order:
 *   1. ERC8004_<ROLE>_AGENT_ID env set  → reuse it (no tx).
 *   2. Registries unconfigured          → return null (degraded mode).
 *   3. Otherwise                        → register() on-chain, log the new id.
 *
 * Non-throwing: any failure logs a warning and returns null so boot proceeds.
 */
export async function ensureAgentIdentity(
  role: AgentRole,
  log: Logger,
): Promise<number | null> {
  const pinned = env.erc8004AgentId(role);
  if (pinned) {
    const id = Number(pinned);
    log.info('erc-8004 identity (pinned)', { role, agentId: id });
    return Number.isFinite(id) ? id : null;
  }

  const identity = identityAddress();
  if (!identity) {
    log.warn('erc-8004 disabled — ERC8004_IDENTITY_ADDRESS unset', { role });
    return null;
  }

  try {
    const account = serviceAccount(role);
    const wallet = walletFor(role);
    const pub = publicClientFor(demoChain());
    const hash = await wallet.writeContract({
      address: identity,
      abi: IDENTITY_ABI,
      functionName: 'register',
      args: [agentCardUri(role, account.address)],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({
      abi: IDENTITY_ABI,
      eventName: 'AgentRegistered',
      logs: receipt.logs,
    });
    const agentId = logs.length > 0 ? Number(logs[0].args.agentId) : null;
    if (agentId === null) {
      log.warn('erc-8004 register: no AgentRegistered event found', { role, hash });
      return null;
    }
    log.info('erc-8004 identity registered', {
      role,
      agentId,
      txHash: hash,
      reuseHint: `set ERC8004_${role.toUpperCase()}_AGENT_ID=${agentId} to reuse across restarts`,
    });
    return agentId;
  } catch (err) {
    log.warn('erc-8004 register failed — running without on-chain identity', {
      role,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Read an agent's reputation summary. Neutral 50 when no feedback exists. */
export async function getReputation(agentId: number): Promise<ReputationSummary> {
  const reputation = reputationAddress();
  if (!reputation) return { agentId, count: 0, avgScore: 50 };
  const pub = publicClientFor(demoChain());
  const [count, averageScore] = await pub.readContract({
    address: reputation,
    abi: REPUTATION_ABI,
    functionName: 'getSummary',
    args: [BigInt(agentId)],
  });
  const n = Number(count);
  return { agentId, count: n, avgScore: n === 0 ? 50 : Number(averageScore) };
}

/**
 * Leave feedback for an agent after a completed job. `score` is 0..100, `tag`
 * a short category (e.g. "quote", "data", "risk"). Returns the tx hash.
 */
export async function giveFeedback(
  fromRole: AgentRole,
  agentId: number,
  score: number,
  tag: string,
  uri = '',
): Promise<Hex | null> {
  const reputation = reputationAddress();
  if (!reputation) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const wallet = walletFor(fromRole);
  return wallet.writeContract({
    address: reputation,
    abi: REPUTATION_ABI,
    functionName: 'giveFeedback',
    args: [BigInt(agentId), clamped, stringToHex(tag, { size: 32 }), uri],
  });
}
