// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title ReputationRegistry (ERC-8004)
/// @notice Standardized publish/read interface for agent feedback. A client
/// (here: the lead "buyer" agent) calls `giveFeedback` after a paid job; any
/// party can `getSummary` to read an agent's aggregate score before deciding
/// whom to hire.
///
/// Faithful to the ERC-8004 reference interface
/// (github.com/erc-8004/erc-8004-contracts): `giveFeedback`, `readFeedback`,
/// `getSummary`. Security guards mirror the Nuwa implementation: an agent
/// cannot rate itself, and feedback is only accepted for registered agents.
contract ReputationRegistry {
    IdentityRegistry public immutable identity;

    struct Feedback {
        address client; // who left the feedback
        uint8 score; // 0..100
        bytes32 tag; // free-form category (e.g. "quote", "data", "risk")
        string uri; // optional off-chain detail
        uint64 timestamp;
    }

    /// @dev agentId => all feedback ever left for it.
    mapping(uint256 agentId => Feedback[]) private _feedback;
    /// @dev agentId => running sum of scores, for O(1) averages.
    mapping(uint256 agentId => uint256 sum) private _scoreSum;

    event FeedbackGiven(
        uint256 indexed agentId, address indexed client, uint8 score, bytes32 indexed tag, uint256 index
    );

    error UnknownAgent(uint256 agentId);
    error SelfFeedback(uint256 agentId, address caller);
    error ScoreOutOfRange(uint8 score);
    error NoFeedback(uint256 agentId);

    constructor(IdentityRegistry _identity) {
        identity = _identity;
    }

    /// @notice Record feedback for `agentId`. Score must be 0..100. Reverts if
    /// the agent isn't registered or the caller is the agent itself.
    function giveFeedback(uint256 agentId, uint8 score, bytes32 tag, string calldata uri)
        external
        returns (uint256 index)
    {
        if (!identity.exists(agentId)) revert UnknownAgent(agentId);
        if (score > 100) revert ScoreOutOfRange(score);
        // Guard self-rating: neither the token owner nor the operational
        // wallet of this agent may grade its own work.
        if (identity.ownerOf(agentId) == msg.sender || identity.agentWallet(agentId) == msg.sender) {
            revert SelfFeedback(agentId, msg.sender);
        }

        index = _feedback[agentId].length;
        _feedback[agentId].push(
            Feedback({client: msg.sender, score: score, tag: tag, uri: uri, timestamp: uint64(block.timestamp)})
        );
        _scoreSum[agentId] += score;
        emit FeedbackGiven(agentId, msg.sender, score, tag, index);
    }

    /// @notice Aggregate score for an agent. `averageScore` is 0..100; `count`
    /// is the number of feedback entries. Both zero for an agent with none.
    function getSummary(uint256 agentId) external view returns (uint64 count, uint64 averageScore) {
        uint256 n = _feedback[agentId].length;
        count = uint64(n);
        averageScore = n == 0 ? 0 : uint64(_scoreSum[agentId] / n);
    }

    /// @notice Read a single feedback entry by index.
    function readFeedback(uint256 agentId, uint256 index) external view returns (Feedback memory) {
        if (index >= _feedback[agentId].length) revert NoFeedback(agentId);
        return _feedback[agentId][index];
    }

    /// @notice Number of feedback entries for an agent.
    function feedbackCount(uint256 agentId) external view returns (uint256) {
        return _feedback[agentId].length;
    }
}
