// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/erc8004/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/erc8004/ReputationRegistry.sol";

contract Erc8004Test is Test {
    IdentityRegistry identity;
    ReputationRegistry reputation;

    address router = makeAddr("router"); // a specialist agent
    address pm = makeAddr("pm"); // the lead/buyer agent (the client)

    function setUp() public {
        identity = new IdentityRegistry();
        reputation = new ReputationRegistry(identity);
    }

    function test_RegisterAssignsSequentialIds() public {
        vm.prank(router);
        uint256 id1 = identity.register("ipfs://router-card");
        vm.prank(pm);
        uint256 id2 = identity.register("ipfs://pm-card");

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(identity.totalAgents(), 2);
        assertEq(identity.ownerOf(id1), router);
        assertEq(identity.tokenURI(id1), "ipfs://router-card");
        assertTrue(identity.exists(id1));
        assertFalse(identity.exists(99));
    }

    function test_FeedbackUpdatesSummary() public {
        vm.prank(router);
        uint256 routerId = identity.register("ipfs://router-card");

        // No feedback yet → zeroes.
        (uint64 count0, uint64 avg0) = reputation.getSummary(routerId);
        assertEq(count0, 0);
        assertEq(avg0, 0);

        // PM hires router twice and leaves feedback.
        vm.prank(pm);
        reputation.giveFeedback(routerId, 90, "quote", "");
        vm.prank(pm);
        reputation.giveFeedback(routerId, 70, "quote", "ipfs://detail");

        (uint64 count, uint64 avg) = reputation.getSummary(routerId);
        assertEq(count, 2);
        assertEq(avg, 80); // (90 + 70) / 2

        ReputationRegistry.Feedback memory fb = reputation.readFeedback(routerId, 1);
        assertEq(fb.client, pm);
        assertEq(fb.score, 70);
        assertEq(fb.tag, bytes32("quote"));
        assertEq(fb.uri, "ipfs://detail");
    }

    function test_RevertWhen_SelfFeedback() public {
        vm.prank(router);
        uint256 routerId = identity.register("ipfs://router-card");

        vm.expectRevert(
            abi.encodeWithSelector(ReputationRegistry.SelfFeedback.selector, routerId, router)
        );
        vm.prank(router);
        reputation.giveFeedback(routerId, 100, "quote", "");
    }

    function test_RevertWhen_UnknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownAgent.selector, 42));
        vm.prank(pm);
        reputation.giveFeedback(42, 80, "quote", "");
    }

    function test_RevertWhen_ScoreOutOfRange() public {
        vm.prank(router);
        uint256 routerId = identity.register("ipfs://router-card");

        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.ScoreOutOfRange.selector, 101));
        vm.prank(pm);
        reputation.giveFeedback(routerId, 101, "quote", "");
    }

    function test_OnlyOwnerCanSetUri() public {
        vm.prank(router);
        uint256 routerId = identity.register("ipfs://router-card");

        vm.expectRevert(
            abi.encodeWithSelector(IdentityRegistry.NotAgentOwner.selector, routerId, pm)
        );
        vm.prank(pm);
        identity.setAgentURI(routerId, "ipfs://hijack");
    }
}
