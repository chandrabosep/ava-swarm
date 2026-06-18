// Per-tenant session lookup — Model B.
//
// We sign every user's UserOps with the same Executor service keypair
// loaded from env (see @swarm/shared/keys). This function just verifies
// that the user has an active Session row pointing at our service
// address — i.e., they actually granted us authority onchain — and
// returns the shared signer.

import type { LocalAccount } from 'viem';

import {
  db,
  serviceAccount,
  serviceAddress,
  type Session,
} from '@swarm/shared';

export interface SessionContext {
  session: Session;
  account: LocalAccount;
}

/**
 * Returns null if the user has no Executor session, the session is
 * expired, or it points at a different service address than ours
 * (defensive — would only happen if env-rotated and DB stale).
 */
export async function loadExecutorSession(
  walletAddress: string,
): Promise<SessionContext | null> {
  const session = await db().session.findUnique({
    where: {
      walletAddress_agent: { walletAddress, agent: 'executor' },
    },
  });
  if (!session) return null;
  if (session.validUntil.getTime() < Date.now()) return null;

  const ours = serviceAddress('executor');
  if (session.sessionAddress.toLowerCase() !== ours.toLowerCase()) {
    // User granted to a different Executor — probably a previous
    // deployment or someone else's swarm. Don't sign.
    return null;
  }

  return { session, account: serviceAccount('executor') };
}
