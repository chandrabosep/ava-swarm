// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title IdentityRegistry (ERC-8004)
/// @notice On-chain identity for trustless agents. Each agent is an ERC-721
/// token whose `tokenId` IS its `agentId`. The token owner is the agent's
/// controlling wallet (in this swarm: an agent's fixed service keypair).
///
/// Faithful to the ERC-8004 reference interface
/// (github.com/erc-8004/erc-8004-contracts): `register`, `setAgentURI`,
/// `setAgentWallet`. Kept non-upgradeable and dependency-light for a Fuji
/// hackathon deploy — the reference's UUPS proxy + ERC-1271 wallet proofs
/// are out of scope here.
contract IdentityRegistry is ERC721URIStorage {
    /// @dev Next agentId to mint. Starts at 1 so `0` reads as "no agent".
    uint256 private _nextId = 1;

    /// @notice Optional operational wallet an agent acts from, when it differs
    /// from the token owner. Zero means "use ownerOf(agentId)".
    mapping(uint256 agentId => address wallet) public agentWallet;

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentURIUpdated(uint256 indexed agentId, string agentURI);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);

    error NotAgentOwner(uint256 agentId, address caller);

    constructor() ERC721("ERC-8004 Trustless Agent", "AGENT") {}

    /// @notice Register a new agent. Mints an agent NFT to the caller and
    /// returns its `agentId`. `agentURI` points at the agent's metadata card
    /// (name, description, skills) — an off-chain JSON, like an ERC-721
    /// tokenURI.
    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _nextId++;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        agentWallet[agentId] = msg.sender;
        emit AgentRegistered(agentId, msg.sender, agentURI);
    }

    /// @notice Update an agent's metadata pointer. Only the agent's owner.
    function setAgentURI(uint256 agentId, string calldata agentURI) external onlyAgentOwner(agentId) {
        _setTokenURI(agentId, agentURI);
        emit AgentURIUpdated(agentId, agentURI);
    }

    /// @notice Set the operational wallet the agent acts from. Only the owner.
    function setAgentWallet(uint256 agentId, address wallet) external onlyAgentOwner(agentId) {
        agentWallet[agentId] = wallet;
        emit AgentWalletSet(agentId, wallet);
    }

    /// @notice Total number of agents ever registered.
    function totalAgents() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @notice True if `agentId` has been registered.
    function exists(uint256 agentId) public view returns (bool) {
        return _ownerOf(agentId) != address(0);
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        _;
    }
}
