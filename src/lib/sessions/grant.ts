// Grant a session key its permission policy onchain.
//
// Translates our PermissionPolicy DSL into the Smart Sessions module's
// onchain representation (action whitelist + spending caps + expiry) and
// sends the enable-session UserOp via the Safe smart-account client.
//
// Idempotent: if the same (sessionKey, policyHash) is already registered,
// the call is a no-op. Re-granting a fresh policy (e.g. on weekly
// rotation) replaces the prior one.

import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import {
  getSmartSessionsValidator,
  getEnableSessionsAction,
} from '@rhinestone/module-sdk';

import type { SwarmClient } from '@/lib/safe';
import type {
  PermissionPolicy,
  PolicyAction,
  SessionAgent,
  SessionChainState,
  SupportedChain,
} from '@/types/swarm';
import { CHAIN_ID } from '@/types/swarm';

export interface GrantSessionParams {
  swarmClient: SwarmClient;
  chain: SupportedChain;
  agent: SessionAgent;
  /** Public address of the session keypair we're authorizing. */
  sessionAddress: Address;
  policy: PermissionPolicy;
  /** Optional progress callback for the UI. */
  onProgress?: (stage: GrantStage) => void;
}

export type GrantStage =
  | { type: 'building' }
  | { type: 'submitting'; userOpHash?: Hex }
  | { type: 'mined'; txHash: Hex; blockNumber: bigint }
  | { type: 'failed'; error: Error };

export interface GrantResult {
  agent: SessionAgent;
  chainState: SessionChainState;
  policyHash: Hex;
}

export async function grantSession(
  params: GrantSessionParams,
): Promise<GrantResult> {
  const { swarmClient, chain, agent, sessionAddress, policy, onProgress } =
    params;

  onProgress?.({ type: 'building' });

  const sessionsValidator = getSmartSessionsValidator({});

  // Build the per-action policies from our DSL. Each action becomes a tuple
  // (target, selector, policies[]) in the Smart Sessions config.
  const actions = policy.actions.map((a) => ({
    actionTarget: a.contract,
    actionTargetSelector: resolveSelector(a),
    actionPolicies: [], // value caps are applied at the userOp-policy level
  }));

  const policyHash = hashPolicy(policy, sessionAddress, agent);

  // The Smart Sessions module's enable-session action. We pass:
  //   - sessionValidator: the canonical ECDSA-based session validator
  //   - sessionValidatorInitData: ABI-encoded session pubkey
  //   - salt: deterministic per (agent, sessionAddress, policyHash) so
  //     re-granting the same policy doesn't create a new entry
  //   - userOpPolicies: the per-userOp value caps (maxPerTxUsd, etc.)
  //   - actions: the contract+selector whitelist above
  const enableAction = getEnableSessionsAction({
    sessions: [
      {
        sessionValidator: sessionsValidator.address as Address,
        sessionValidatorInitData: encodeAbiParameters(
          [{ type: 'address' }],
          [sessionAddress],
        ),
        salt: policyHash,
        userOpPolicies: buildUserOpPolicies(policy),
        erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
        actions,
        permitERC4337Paymaster: false,
      },
    ],
  });

  let userOpHash: Hex;
  try {
    userOpHash = await swarmClient.smartAccountClient.sendUserOperation({
      calls: [
        {
          to: enableAction.target as Address,
          value: enableAction.value ?? 0n,
          data: enableAction.callData as Hex,
        },
      ],
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onProgress?.({ type: 'failed', error });
    throw error;
  }

  onProgress?.({ type: 'submitting', userOpHash });

  const receipt =
    await swarmClient.smartAccountClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

  if (!receipt.success) {
    const error = new Error(
      `Grant UserOp ${userOpHash} reverted on ${chain}`,
    );
    onProgress?.({ type: 'failed', error });
    throw error;
  }

  onProgress?.({
    type: 'mined',
    txHash: receipt.receipt.transactionHash,
    blockNumber: receipt.receipt.blockNumber,
  });

  return {
    agent,
    policyHash,
    chainState: {
      chain,
      chainId: CHAIN_ID[chain],
      registered: true,
      registrationTxHash: receipt.receipt.transactionHash,
    },
  };
}

// --- Helpers ----------------------------------------------------------------

function resolveSelector(action: PolicyAction): Hex {
  if (action.selector === 'any') {
    // Smart Sessions interprets the zero selector as "any function on this
    // contract". Worth flagging in the UI when the user picks this for
    // anything they didn't whitelist explicitly.
    return '0x00000000';
  }
  // Already a selector — let it through unchanged. Defensive cast: if the
  // caller supplied a full signature like `execute(bytes,bytes[])`, hash it.
  if (action.selector.length === 10) {
    return action.selector;
  }
  return toFunctionSelector(action.selector as string);
}

interface UserOpPolicy {
  policy: Address;
  initData: Hex;
}

/**
 * Convert our PermissionPolicy USD caps into the Smart Sessions userOp
 * policies. We target the canonical Rhinestone "spending limit" policy
 * contracts; their addresses are returned by the module-sdk's helpers.
 *
 * For Phase A we encode raw caps without per-token conversion — the
 * dashboard surfaces the USD numbers and the policy contract handles
 * the price-feed translation.
 */
function buildUserOpPolicies(policy: PermissionPolicy): UserOpPolicy[] {
  const out: UserOpPolicy[] = [];

  if (policy.maxPerTxUsd) {
    out.push(spendingLimitPolicy(policy.maxPerTxUsd, 'per-tx'));
  }
  if (policy.maxPerDayUsd) {
    out.push(spendingLimitPolicy(policy.maxPerDayUsd, 'per-day'));
  }
  if (policy.validUntil) {
    out.push(timeFramePolicy(policy.validUntil));
  }

  return out;
}

/**
 * Placeholder for the Rhinestone spending-limit policy address. The real
 * address ships with @rhinestone/module-sdk; replace this with the
 * `getSpendingLimitsPolicy()` helper once the SDK version is pinned.
 */
function spendingLimitPolicy(
  cap: bigint,
  _kind: 'per-tx' | 'per-day',
): UserOpPolicy {
  return {
    policy: '0x0000000000000000000000000000000000000000',
    initData: encodeAbiParameters([{ type: 'uint256' }], [cap]),
  };
}

function timeFramePolicy(validUntil: number): UserOpPolicy {
  return {
    policy: '0x0000000000000000000000000000000000000000',
    initData: encodeAbiParameters(
      [{ type: 'uint128' }, { type: 'uint128' }],
      [BigInt(validUntil), 0n],
    ),
  };
}

/**
 * Stable hash of a policy, useful as a Smart Sessions salt and as a UI
 * fingerprint ("policy A vs policy B"). Excludes anything mutable so that
 * re-rendering the same policy produces the same hash.
 */
function hashPolicy(
  policy: PermissionPolicy,
  sessionAddress: Address,
  agent: SessionAgent,
): Hex {
  const actionsBlob = policy.actions
    .map((a) => `${a.contract.toLowerCase()}:${a.selector}`)
    .sort()
    .join('|');
  return keccak256(
    encodePacked(
      ['address', 'string', 'string', 'uint256', 'uint256', 'uint256'],
      [
        sessionAddress,
        agent,
        actionsBlob,
        policy.maxPerTxUsd ?? 0n,
        policy.maxPerDayUsd ?? 0n,
        BigInt(policy.validUntil),
      ],
    ),
  );
}
