// Per-tenant session lookup.
//
// Loads the user's encrypted Executor session privkey from Postgres,
// decrypts in-memory, returns a viem LocalAccount. The privkey never
// leaves this process; the cleartext is GC'd as soon as the LocalAccount
// is constructed. Postgres + AGENT_PRIVKEY_ENCRYPTION_KEY together form
// the "two factors" — DB compromise alone or env compromise alone is
// insufficient to forge UserOps.

import { privateKeyToAccount } from 'viem/accounts';
import type { LocalAccount } from 'viem';

import { db, decryptPrivkey, type Session } from '@swarm/shared';

export interface SessionContext {
  session: Session;
  account: LocalAccount;
}

/** Returns null if the user has no Executor session, or it's expired. */
export async function loadExecutorSession(
  safeAddress: string,
): Promise<SessionContext | null> {
  const session = await db().session.findUnique({
    where: {
      safeAddress_agent: { safeAddress, agent: 'executor' },
    },
  });
  if (!session) return null;
  if (session.validUntil.getTime() < Date.now()) return null;

  const privkey = decryptPrivkey(session.encryptedPrivkey);
  const account = privateKeyToAccount(privkey);

  return { session, account };
}
