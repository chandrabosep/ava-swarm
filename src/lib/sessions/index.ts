// Barrel re-export — components and hooks import from `@/lib/sessions`
// and stay decoupled from the file layout inside.

export {
  generateSessionKeypair,
  storeSession,
  loadSession,
  listSessionAddresses,
  clearSession,
  clearAllSessions,
  type SessionKeypair,
  type StoreParams as StoreSessionParams,
} from './storage';

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
