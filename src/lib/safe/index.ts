// Barrel re-export. Components import from `@/lib/safe` rather than the
// individual files so refactors inside this directory don't ripple.

export {
  predictSmartAccountAddress,
  assertCrossChainAddressParity,
  chainIdOf,
  SAFE_4337_MODULE_ADDRESS,
  SAFE_VERSION,
  DEFAULT_SALT_NONCE,
  type PredictParams,
} from './predict';

export {
  createSwarmClient,
  publicClientFor,
  pimlicoClientFor,
  type SwarmClient,
  type SwarmClientParams,
} from './client';

export {
  activateOnChain,
  readDeploymentState,
  type ActivateOnChainParams,
  type ActivationStage,
  type ActivationResult,
} from './deploy';
