// Encrypted-at-rest session keypair storage.
//
// PHASE A NOTE: this is a deliberate stop-gap. The encryption key is
// derived from the owner's EOA address (a value that's already public),
// which means localStorage exfiltration alone doesn't reveal the session
// private keys but anyone who can read localStorage on this device with
// knowledge of the owner address can decrypt them. That's acceptable for
// Phase A because:
//   - the only way to read localStorage from another origin is an XSS
//     bug in our extension page (we're already trusting our own code)
//   - the session keys themselves are rate-limited + scope-limited by the
//     onchain Smart Sessions validator, so even a leaked key can't drain
//     the Safe outside its policy envelope
//   - Phase B replaces all this with agent-side keypair generation: the
//     extension never holds session private keys at all, the agents do
//
// Until Phase B lands, treat the localStorage encryption as obfuscation,
// not real protection.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';

import type {
  SessionAgent,
  StoredSessionBlob,
} from '@/types/swarm';

const STORAGE_KEY_PREFIX = 'defi-swarm:session:';
const SCHEMA_VERSION = 1 as const;

export interface SessionKeypair {
  address: Address;
  privateKey: Hex;
}

/** Generate a fresh keypair the agent will eventually receive. */
export function generateSessionKeypair(): SessionKeypair {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKey };
}

// --- Encryption ------------------------------------------------------------

/** Derive a stable AES-GCM key from the owner address. Phase A only. */
async function deriveKey(owner: Address): Promise<CryptoKey> {
  const seed = keccak256(stringToHex(`swarm:v1:${owner.toLowerCase()}`));
  // keccak256 returns 0x-prefixed 32-byte hex — trim and convert to bytes.
  const seedBytes = hexToBytes(seed);
  return await crypto.subtle.importKey(
    'raw',
    seedBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Persistence -----------------------------------------------------------

function storageKey(owner: Address, agent: SessionAgent): string {
  return `${STORAGE_KEY_PREFIX}${owner.toLowerCase()}:${agent}`;
}

export interface StoreParams {
  agent: SessionAgent;
  owner: Address;
  keypair: SessionKeypair;
}

export async function storeSession(params: StoreParams): Promise<void> {
  const key = await deriveKey(params.owner);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    hexToBytes(params.keypair.privateKey) as unknown as BufferSource,
  );
  const blob: StoredSessionBlob = {
    agent: params.agent,
    address: params.keypair.address,
    iv: bytesToBase64(iv),
    cipherText: bytesToBase64(cipherBuffer),
    owner: params.owner,
    version: SCHEMA_VERSION,
  };
  localStorage.setItem(
    storageKey(params.owner, params.agent),
    JSON.stringify(blob),
  );
}

export async function loadSession(
  owner: Address,
  agent: SessionAgent,
): Promise<SessionKeypair | null> {
  const raw = localStorage.getItem(storageKey(owner, agent));
  if (!raw) return null;

  let blob: StoredSessionBlob;
  try {
    blob = JSON.parse(raw) as StoredSessionBlob;
  } catch {
    return null;
  }
  if (blob.version !== SCHEMA_VERSION) return null;

  const key = await deriveKey(owner);
  const iv = base64ToBytes(blob.iv);
  const cipher = base64ToBytes(blob.cipherText);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    cipher as unknown as BufferSource,
  );
  const u8 = new Uint8Array(plain);
  const privateKey = `0x${[...u8]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as Hex;

  return { address: blob.address, privateKey };
}

export function listSessionAddresses(
  owner: Address,
): Partial<Record<SessionAgent, Address>> {
  const out: Partial<Record<SessionAgent, Address>> = {};
  for (const agent of ['alm', 'executor'] as const) {
    const raw = localStorage.getItem(storageKey(owner, agent));
    if (!raw) continue;
    try {
      const blob = JSON.parse(raw) as StoredSessionBlob;
      out[agent] = blob.address;
    } catch {
      // ignore malformed
    }
  }
  return out;
}

export function clearSession(owner: Address, agent: SessionAgent): void {
  localStorage.removeItem(storageKey(owner, agent));
}

export function clearAllSessions(owner: Address): void {
  for (const agent of ['alm', 'executor'] as const) {
    clearSession(owner, agent);
  }
}
