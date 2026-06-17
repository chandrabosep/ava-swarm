// Barrel re-export — components and hooks import from `@/lib/sessions`
// and stay decoupled from the file layout inside.
//
// Model B note: storage.ts (per-user keypair generation + AES-encrypted
// localStorage) was removed. Service privkeys live on the agent servers,
// addresses are hardcoded in src/config/swarm.ts.

export {
  CONTRACTS,
  DEFAULT_TTL_SECONDS,
  ttlFromNow,
  defaultExecutorPolicy,
  defaultAlmPolicy,
  defaultPolicyFor,
} from './policies';

export {
  grantSession,
  type GrantSessionParams,
  type GrantStage,
  type GrantResult,
} from './grant';
