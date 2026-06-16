// AES-256-GCM encryption for session privkeys at rest.
//
// Threat model: Postgres compromise OR any read access to the `sessions`
// table should not leak private keys. The encryption key lives in the
// agent process env (AGENT_PRIVKEY_ENCRYPTION_KEY) and is loaded at boot.
//
// Phase B improvement over Phase A: keys are still encrypted, but they
// live on the agent server (not the user's browser), so XSS in the
// extension can't reach them.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from './env.js';

interface EncryptedBlob {
  iv: string;
  tag: string;
  cipherText: string;
}

const ALGO = 'aes-256-gcm';

function key(): Buffer {
  const hex = env.encryptionKey();
  if (hex.length !== 64) {
    throw new Error(
      'AGENT_PRIVKEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars). Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptPrivkey(plaintextHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const plain = Buffer.from(
    plaintextHex.startsWith('0x') ? plaintextHex.slice(2) : plaintextHex,
    'hex',
  );
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    cipherText: encrypted.toString('base64'),
  };
  return JSON.stringify(blob);
}

export function decryptPrivkey(blobJson: string): `0x${string}` {
  const blob = JSON.parse(blobJson) as EncryptedBlob;
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const cipherText = Buffer.from(blob.cipherText, 'base64');
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return `0x${plain.toString('hex')}`;
}
