// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/erc8004/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/erc8004/ReputationRegistry.sol";

/// @notice Deploy the ERC-8004 registries to Avalanche Fuji.
///
/// Usage:
///   forge script script/DeployErc8004.s.sol:DeployErc8004 \
///     --rpc-url avalanche-fuji --broadcast --private-key $DEPLOYER_PRIVKEY
///
/// Paste the two logged addresses into agents/.env as
/// ERC8004_IDENTITY_ADDRESS / ERC8004_REPUTATION_ADDRESS (and the extension's
/// VITE_* equivalents if the dashboard reads them directly).
contract DeployErc8004 is Script {
    function run() external returns (IdentityRegistry identity, ReputationRegistry reputation) {
        vm.startBroadcast();
        identity = new IdentityRegistry();
        reputation = new ReputationRegistry(identity);
        vm.stopBroadcast();

        console2.log("IdentityRegistry  :", address(identity));
        console2.log("ReputationRegistry:", address(reputation));
    }
}
