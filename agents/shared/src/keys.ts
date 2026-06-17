// Agent service keys.
//
// Model B: each agent has ONE fixed keypair, loaded from env at boot.
// Every user grants their Safe's Smart Sessions policy to the agent's
// public address. The agent uses that single keypair to sign UserOps
// for any user.
//
// Compromise blast radius is bounded by the per-user policy enforced
// onchain by the Smart Sessions module — even with the agent privkey,
// an attacker can only do what the policy allows for each user (cap
// per-tx, cap per-day, whitelist of contracts).
//
// Service pubkeys are also exported as constants in src/constants.ts
// so the extension can hardcode them in its grant flow.

import { privateKeyToAccount } from 'viem/accounts';
import type { Address, LocalAccount } from 'viem';

import type { AgentRole } from './db.js';

/** Cache by role. Agents only sign as themselves. */
const cache = new Map<AgentRole, LocalAccount>();

export function serviceAccount(role: AgentRole): LocalAccount {
  const cached = cache.get(role);
  if (cached) return cached;

  const envName = SERVICE_ENV[role];
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `[keys] ${envName} is not set. This agent (${role}) cannot sign without its service privkey.`,
    );
  }
  const privkey = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
  if (privkey.length !== 66) {
    throw new Error(
      `[keys] ${envName} must be 32 bytes (64 hex chars). Generate with viem's generatePrivateKey() or openssl rand -hex 32.`,
    );
  }
  const account = privateKeyToAccount(privkey);
  cache.set(role, account);
  return account;
}

export function serviceAddress(role: AgentRole): Address {
  return serviceAccount(role).address;
}

const SERVICE_ENV: Record<AgentRole, string> = {
  pm: 'PM_SERVICE_PRIVKEY',
  alm: 'ALM_SERVICE_PRIVKEY',
  router: 'ROUTER_SERVICE_PRIVKEY',
  executor: 'EXECUTOR_SERVICE_PRIVKEY',
};
