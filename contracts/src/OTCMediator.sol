// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

/// @title OTCMediator
/// @notice Atomic two-leg settlement for OTC swaps coordinated off-chain by the agent swarm.
///
/// Flow:
///   - Two user EOAs A and B are matched off-chain by their Routers (each holding a session
///     key authorized via EIP-7702 delegation).
///   - Each Router signs a Permit2 PermitWitnessTransferFrom message on behalf of its user.
///     Under EIP-7702, Permit2's signature check against `owner` falls back to ERC-1271
///     `isValidSignature` on the EOA's delegate, which validates the session-key sig.
///   - The witness binds each leg to the match: `(matchId, counterparty, counterToken,
///     counterAmount, deadline)`. A sig from user A is cryptographically locked to user B
///     receiving counterToken/counterAmount — it cannot be re-used in a different match,
///     and the recipient cannot be swapped by the caller.
///   - settleMatch calls Permit2.permitWitnessTransferFrom for both legs in one tx. If
///     either reverts, both roll back — atomicity by EVM tx semantics.
///
/// Permissionless to call: anyone with valid sigs can settle. Replay protection comes from
/// (a) Permit2's per-user nonce bitmap and (b) this contract's `settled[matchId]`.
contract OTCMediator {
    ISignatureTransfer public immutable PERMIT2;

    /// @dev Witness type — appended to Permit2's TokenPermissions to bind a sig to a match.
    bytes32 public constant WITNESS_TYPEHASH = keccak256(
        "OtcMatch(bytes32 matchId,address counterparty,address counterToken,uint256 counterAmount,uint256 deadline)"
    );

    /// @dev Permit2 expects the witness type string in this exact concatenated form.
    /// Format: <witnessName> <type>)<witnessType>TokenPermissions(address token,uint256 amount)
    string public constant WITNESS_TYPE_STRING =
        "OtcMatch witness)OtcMatch(bytes32 matchId,address counterparty,address counterToken,uint256 counterAmount,uint256 deadline)TokenPermissions(address token,uint256 amount)";

    mapping(bytes32 matchId => bool) public settled;

    error MatchAlreadySettled(bytes32 matchId);
    error MatchExpired(uint256 deadline);
    error SameUser();
    error ZeroAmount();

    event Settled(
        bytes32 indexed matchId,
        address indexed userA,
        address indexed userB,
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB
    );

    struct Leg {
        address user;       // EOA whose tokens move (Permit2 owner — validated via 1271 under 7702)
        address token;
        uint256 amount;
        uint256 nonce;      // Permit2 per-owner nonce
        uint256 deadline;   // Permit2 sig deadline
        bytes signature;    // session-key sig over Permit2 PermitWitnessTransferFrom payload
    }

    struct Match {
        bytes32 matchId;
        Leg legA;
        Leg legB;
        uint256 deadline;   // mediator-level deadline (binds to witness)
    }

    constructor(ISignatureTransfer permit2) {
        PERMIT2 = permit2;
    }

    function settleMatch(Match calldata m) external {
        if (settled[m.matchId]) revert MatchAlreadySettled(m.matchId);
        if (block.timestamp > m.deadline) revert MatchExpired(m.deadline);
        if (m.legA.user == m.legB.user) revert SameUser();
        if (m.legA.amount == 0 || m.legB.amount == 0) revert ZeroAmount();

        settled[m.matchId] = true;

        _pullLeg({
            matchId: m.matchId,
            leg: m.legA,
            counterparty: m.legB.user,
            counterToken: m.legB.token,
            counterAmount: m.legB.amount,
            matchDeadline: m.deadline
        });
        _pullLeg({
            matchId: m.matchId,
            leg: m.legB,
            counterparty: m.legA.user,
            counterToken: m.legA.token,
            counterAmount: m.legA.amount,
            matchDeadline: m.deadline
        });

        emit Settled(
            m.matchId,
            m.legA.user,
            m.legB.user,
            m.legA.token,
            m.legB.token,
            m.legA.amount,
            m.legB.amount
        );
    }

    function _pullLeg(
        bytes32 matchId,
        Leg calldata leg,
        address counterparty,
        address counterToken,
        uint256 counterAmount,
        uint256 matchDeadline
    ) internal {
        bytes32 witness = keccak256(
            abi.encode(
                WITNESS_TYPEHASH,
                matchId,
                counterparty,
                counterToken,
                counterAmount,
                matchDeadline
            )
        );

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: leg.token, amount: leg.amount}),
            nonce: leg.nonce,
            deadline: leg.deadline
        });

        ISignatureTransfer.SignatureTransferDetails memory details =
            ISignatureTransfer.SignatureTransferDetails({to: counterparty, requestedAmount: leg.amount});

        PERMIT2.permitWitnessTransferFrom(
            permit,
            details,
            leg.user,
            witness,
            WITNESS_TYPE_STRING,
            leg.signature
        );
    }
}
