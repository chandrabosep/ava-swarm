// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OTCMediator} from "../src/OTCMediator.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {MockPermit2, MockERC20} from "./MockPermit2.sol";

contract OTCMediatorTest is Test {
    OTCMediator mediator;
    MockPermit2 permit2;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address userA = address(0xA11CE);
    address userB = address(0xB0B);
    address randomCaller = address(0xCAFE);

    uint256 constant AMOUNT_A = 1_000e18;
    uint256 constant AMOUNT_B = 2_500e18;

    function setUp() public {
        permit2 = new MockPermit2();
        mediator = new OTCMediator(permit2);
        tokenA = new MockERC20("TokenA", "TKA");
        tokenB = new MockERC20("TokenB", "TKB");

        tokenA.mint(userA, AMOUNT_A);
        tokenB.mint(userB, AMOUNT_B);

        vm.prank(userA);
        tokenA.approve(address(permit2), type(uint256).max);
        vm.prank(userB);
        tokenB.approve(address(permit2), type(uint256).max);
    }

    function _buildMatch(bytes32 matchId, uint256 deadline)
        internal
        view
        returns (OTCMediator.Match memory m)
    {
        m = OTCMediator.Match({
            matchId: matchId,
            legA: OTCMediator.Leg({
                user: userA,
                token: address(tokenA),
                amount: AMOUNT_A,
                nonce: 1,
                deadline: deadline,
                signature: hex"deadbeef"
            }),
            legB: OTCMediator.Leg({
                user: userB,
                token: address(tokenB),
                amount: AMOUNT_B,
                nonce: 1,
                deadline: deadline,
                signature: hex"cafebabe"
            }),
            deadline: deadline
        });
    }

    function _expectedWitness(
        bytes32 matchId,
        address counterparty,
        address counterToken,
        uint256 counterAmount,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                mediator.WITNESS_TYPEHASH(),
                matchId,
                counterparty,
                counterToken,
                counterAmount,
                deadline
            )
        );
    }

    // ─── Happy path ─────────────────────────────────────────────────────

    function test_settleMatch_movesTokens() public {
        bytes32 matchId = keccak256("match-1");
        uint256 deadline = block.timestamp + 1 hours;

        vm.expectEmit(true, true, true, true);
        emit OTCMediator.Settled(
            matchId, userA, userB, address(tokenA), address(tokenB), AMOUNT_A, AMOUNT_B
        );

        vm.prank(randomCaller);
        mediator.settleMatch(_buildMatch(matchId, deadline));

        assertEq(tokenA.balanceOf(userA), 0, "userA tokenA drained");
        assertEq(tokenA.balanceOf(userB), AMOUNT_A, "userB received tokenA");
        assertEq(tokenB.balanceOf(userB), 0, "userB tokenB drained");
        assertEq(tokenB.balanceOf(userA), AMOUNT_B, "userA received tokenB");
        assertTrue(mediator.settled(matchId));
    }

    function test_settleMatch_callsPermit2WithBoundWitness() public {
        bytes32 matchId = keccak256("match-witness");
        uint256 deadline = block.timestamp + 1 hours;

        mediator.settleMatch(_buildMatch(matchId, deadline));

        assertEq(permit2.callsLength(), 2, "two Permit2 calls expected");

        // Leg A: userA's sig, witness binds to userB receiving AMOUNT_B of tokenB
        MockPermit2.Call memory callA = permit2.getCall(0);
        assertEq(callA.owner, userA);
        assertEq(callA.to, userB);
        assertEq(callA.token, address(tokenA));
        assertEq(callA.amount, AMOUNT_A);
        assertEq(
            callA.witness,
            _expectedWitness(matchId, userB, address(tokenB), AMOUNT_B, deadline),
            "leg A witness must bind counterparty=userB, counterToken=tokenB, counterAmount=AMOUNT_B"
        );
        assertEq(callA.signature, hex"deadbeef");

        // Leg B: userB's sig, witness binds to userA receiving AMOUNT_A of tokenA
        MockPermit2.Call memory callB = permit2.getCall(1);
        assertEq(callB.owner, userB);
        assertEq(callB.to, userA);
        assertEq(callB.token, address(tokenB));
        assertEq(callB.amount, AMOUNT_B);
        assertEq(
            callB.witness,
            _expectedWitness(matchId, userA, address(tokenA), AMOUNT_A, deadline),
            "leg B witness must bind counterparty=userA, counterToken=tokenA, counterAmount=AMOUNT_A"
        );
        assertEq(callB.signature, hex"cafebabe");
    }

    function test_settleMatch_anyoneCanCall() public {
        bytes32 matchId = keccak256("match-permissionless");
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(randomCaller);
        mediator.settleMatch(_buildMatch(matchId, deadline));

        assertTrue(mediator.settled(matchId));
    }

    // ─── Replay protection ─────────────────────────────────────────────

    function test_settleMatch_revertsOnReplay() public {
        bytes32 matchId = keccak256("match-replay");
        uint256 deadline = block.timestamp + 1 hours;

        mediator.settleMatch(_buildMatch(matchId, deadline));

        // Even with fresh nonces in a new match struct, the matchId guard fires.
        OTCMediator.Match memory replay = _buildMatch(matchId, deadline);
        replay.legA.nonce = 99;
        replay.legB.nonce = 99;

        vm.expectRevert(abi.encodeWithSelector(OTCMediator.MatchAlreadySettled.selector, matchId));
        mediator.settleMatch(replay);
    }

    function test_settleMatch_permit2NonceReuseReverts() public {
        // Two distinct matchIds reusing the same Permit2 nonce should fail
        // on the Permit2 layer's per-owner nonce bitmap.
        bytes32 m1 = keccak256("match-1");
        bytes32 m2 = keccak256("match-2");
        uint256 deadline = block.timestamp + 1 hours;

        // Need fresh balances to hit the nonce-reuse error rather than insufficient-balance.
        tokenA.mint(userA, AMOUNT_A);
        tokenB.mint(userB, AMOUNT_B);

        mediator.settleMatch(_buildMatch(m1, deadline));

        // m2 reuses nonce=1 → MockPermit2.NonceUsed
        vm.expectRevert(MockPermit2.NonceUsed.selector);
        mediator.settleMatch(_buildMatch(m2, deadline));
    }

    // ─── Deadline ──────────────────────────────────────────────────────

    function test_settleMatch_revertsAfterDeadline() public {
        bytes32 matchId = keccak256("match-stale");
        uint256 deadline = block.timestamp + 1 hours;
        OTCMediator.Match memory m = _buildMatch(matchId, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(OTCMediator.MatchExpired.selector, deadline));
        mediator.settleMatch(m);
    }

    function test_settleMatch_succeedsAtDeadline() public {
        bytes32 matchId = keccak256("match-edge");
        uint256 deadline = block.timestamp + 1 hours;
        OTCMediator.Match memory m = _buildMatch(matchId, deadline);

        vm.warp(deadline);
        mediator.settleMatch(m);
        assertTrue(mediator.settled(matchId));
    }

    // ─── Input validation ─────────────────────────────────────────────

    function test_settleMatch_revertsOnSameUser() public {
        bytes32 matchId = keccak256("match-self");
        uint256 deadline = block.timestamp + 1 hours;
        OTCMediator.Match memory m = _buildMatch(matchId, deadline);
        m.legB.user = userA;

        vm.expectRevert(OTCMediator.SameUser.selector);
        mediator.settleMatch(m);
    }

    function test_settleMatch_revertsOnZeroLegA() public {
        bytes32 matchId = keccak256("match-zero-a");
        uint256 deadline = block.timestamp + 1 hours;
        OTCMediator.Match memory m = _buildMatch(matchId, deadline);
        m.legA.amount = 0;

        vm.expectRevert(OTCMediator.ZeroAmount.selector);
        mediator.settleMatch(m);
    }

    function test_settleMatch_revertsOnZeroLegB() public {
        bytes32 matchId = keccak256("match-zero-b");
        uint256 deadline = block.timestamp + 1 hours;
        OTCMediator.Match memory m = _buildMatch(matchId, deadline);
        m.legB.amount = 0;

        vm.expectRevert(OTCMediator.ZeroAmount.selector);
        mediator.settleMatch(m);
    }

    // ─── Atomicity ─────────────────────────────────────────────────────

    function test_settleMatch_atomicOnLegBFailure() public {
        bytes32 matchId = keccak256("match-atomic");
        uint256 deadline = block.timestamp + 1 hours;

        // userB has only enough for AMOUNT_B; if leg B requests more, transferFrom panics.
        OTCMediator.Match memory m = _buildMatch(matchId, deadline);
        m.legB.amount = AMOUNT_B + 1;

        uint256 balABefore = tokenA.balanceOf(userA);
        uint256 balBBefore = tokenB.balanceOf(userB);

        vm.expectRevert(); // arithmetic underflow inside MockERC20.transferFrom
        mediator.settleMatch(m);

        // Leg A's transfer must have rolled back.
        assertEq(tokenA.balanceOf(userA), balABefore, "leg A rolled back");
        assertEq(tokenB.balanceOf(userB), balBBefore, "leg B never moved");
        assertFalse(mediator.settled(matchId), "matchId not marked settled on revert");
    }

    // ─── Witness type string ──────────────────────────────────────────

    function test_witnessTypeString_isPassedToPermit2Verbatim() public {
        bytes32 matchId = keccak256("match-typestring");
        uint256 deadline = block.timestamp + 1 hours;

        mediator.settleMatch(_buildMatch(matchId, deadline));

        MockPermit2.Call memory call0 = permit2.getCall(0);
        assertEq(call0.witnessTypeString, mediator.WITNESS_TYPE_STRING());
    }
}
