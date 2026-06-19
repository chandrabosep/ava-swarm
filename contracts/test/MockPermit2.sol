// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Test stand-in for Uniswap Permit2.
/// Records every call's witness + parameters so tests can assert the mediator
/// produced exactly the right Permit2 payloads. Performs the underlying
/// transferFrom against a token contract (so balance assertions still work)
/// but skips the EIP-712 sig recovery — the real Permit2 covers that.
contract MockPermit2 is ISignatureTransfer {
    struct Call {
        address owner;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        address to;
        uint256 requestedAmount;
        bytes32 witness;
        string witnessTypeString;
        bytes signature;
    }

    Call[] internal _calls;
    mapping(address owner => mapping(uint256 nonce => bool)) public usedNonces;

    error NonceUsed();

    function callsLength() external view returns (uint256) {
        return _calls.length;
    }

    function getCall(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return bytes32(uint256(0xDEAD));
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        _record(permit, transferDetails, owner, bytes32(0), "", signature);
        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        _record(permit, transferDetails, owner, witness, witnessTypeString, signature);
        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    function _record(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) internal {
        if (usedNonces[owner][permit.nonce]) revert NonceUsed();
        usedNonces[owner][permit.nonce] = true;
        _calls.push(Call({
            owner: owner,
            token: permit.permitted.token,
            amount: permit.permitted.amount,
            nonce: permit.nonce,
            deadline: permit.deadline,
            to: transferDetails.to,
            requestedAmount: transferDetails.requestedAmount,
            witness: witness,
            witnessTypeString: witnessTypeString,
            signature: signature
        }));
    }
}

/// @notice Minimal ERC20 used by the mediator tests.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
