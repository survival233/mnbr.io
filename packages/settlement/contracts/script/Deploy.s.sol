// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HandoverEscrow} from "../src/HandoverEscrow.sol";

/**
 * Deploy HandoverEscrow.
 *
 * Base Sepolia (the sandbox): use Circle's testnet USDC. Confirm the current
 * address in Circle's docs before deploying — testnet addresses do change.
 * As of writing, Base Sepolia USDC is commonly 0x036CbD53842c5426634e7929541eC2318f3dCF7e.
 *
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
 *
 * Required env:
 *   PRIVATE_KEY   deployer/owner key (the broadcaster)
 *   USDC_ADDRESS  USDC token on the target chain
 *   TREASURY      Manebra commission sink
 *   OPERATOR      backend key allowed to open() escrows
 *   ATTESTOR      backend key whose signature releases/refunds
 *   OWNER         admin key that can rotate roles (never touches funds)
 */
contract Deploy is Script {
    function run() external returns (HandoverEscrow escrow) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY");
        address operator = vm.envAddress("OPERATOR");
        address attestor = vm.envAddress("ATTESTOR");
        address owner = vm.envAddress("OWNER");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        escrow = new HandoverEscrow(usdc, treasury, operator, attestor, owner);
        vm.stopBroadcast();

        console2.log("HandoverEscrow deployed:", address(escrow));
        console2.log("  usdc     ", usdc);
        console2.log("  treasury ", treasury);
        console2.log("  operator ", operator);
        console2.log("  attestor ", attestor);
        console2.log("  owner    ", owner);
    }
}
