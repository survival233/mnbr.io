// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HandoverEscrow} from "../src/HandoverEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract HandoverEscrowTest is Test {
    HandoverEscrow escrow;
    MockUSDC usdc;

    // roles
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address payer = makeAddr("payer"); // shopper
    address payee = makeAddr("payee"); // traveler
    uint256 attestorPk;
    address attestor;
    uint256 attackerPk;
    address attacker;

    // PRD worked example, in USDC base units (6 dp)
    uint256 constant PAYEE_AMOUNT = 120_000000; // $120 subtotal
    uint256 constant FEE_AMOUNT = 18_000000; // $18 commission
    uint256 constant TOTAL = PAYEE_AMOUNT + FEE_AMOUNT; // $138

    uint8 constant ACTION_RELEASE = 1;
    uint8 constant ACTION_REFUND = 2;

    bytes32 constant ATTESTATION_TYPEHASH =
        keccak256("HandoverAttestation(bytes32 escrowId,uint8 action,uint64 deadline)");

    function setUp() public {
        (attestor, attestorPk) = makeAddrAndKey("attestor");
        (attacker, attackerPk) = makeAddrAndKey("attacker");

        usdc = new MockUSDC();
        escrow = new HandoverEscrow(address(usdc), treasury, operator, attestor, owner);

        usdc.mint(payer, 1_000_000_000000); // $1M test float
    }

    // ---- helpers ----

    function _sign(uint256 pk, bytes32 escrowId, uint8 action, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, escrowId, action, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openAndFund(bytes32 id, uint64 refundDeadline) internal {
        vm.prank(operator);
        escrow.open(id, payer, payee, PAYEE_AMOUNT, FEE_AMOUNT, refundDeadline);
        vm.startPrank(payer);
        usdc.approve(address(escrow), TOTAL);
        escrow.fund(id);
        vm.stopPrank();
    }

    // ---- happy paths ----

    function test_Release_PaysPayeeAndTreasury() public {
        bytes32 id = keccak256("bid-A");
        _openAndFund(id, uint64(block.timestamp + 1 days));
        assertEq(usdc.balanceOf(address(escrow)), TOTAL, "escrow holds total");
        assertEq(uint8(escrow.stateOf(id)), uint8(HandoverEscrow.State.Funded));

        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory sig = _sign(attestorPk, id, ACTION_RELEASE, deadline);

        // permissionless relay: submit from payee, not the platform
        vm.prank(payee);
        escrow.release(id, deadline, sig);

        assertEq(usdc.balanceOf(payee), PAYEE_AMOUNT, "payee got subtotal");
        assertEq(usdc.balanceOf(treasury), FEE_AMOUNT, "treasury got commission");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
        assertEq(uint8(escrow.stateOf(id)), uint8(HandoverEscrow.State.Released));
    }

    function test_Refund_ReturnsFullTotal() public {
        bytes32 id = keccak256("bid-B");
        uint256 before = usdc.balanceOf(payer);
        _openAndFund(id, uint64(block.timestamp + 1 days));

        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory sig = _sign(attestorPk, id, ACTION_REFUND, deadline);
        vm.prank(operator);
        escrow.refund(id, deadline, sig);

        assertEq(usdc.balanceOf(payer), before, "payer made whole");
        assertEq(usdc.balanceOf(treasury), 0, "no commission on refund");
        assertEq(uint8(escrow.stateOf(id)), uint8(HandoverEscrow.State.Refunded));
    }

    function test_Reclaim_AfterDeadline_NoAttestation() public {
        bytes32 id = keccak256("bid-C");
        uint256 before = usdc.balanceOf(payer);
        uint64 deadline = uint64(block.timestamp + 100);
        _openAndFund(id, deadline);

        vm.warp(deadline + 1);
        vm.prank(payer);
        escrow.reclaim(id); // no signature required

        assertEq(usdc.balanceOf(payer), before, "payer reclaimed everything");
        assertEq(uint8(escrow.stateOf(id)), uint8(HandoverEscrow.State.Refunded));
    }

    // ---- guards / negative ----

    function test_Release_RevertsOnNonAttestorSignature() public {
        bytes32 id = keccak256("bid-D");
        _openAndFund(id, uint64(block.timestamp + 1 days));
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory badSig = _sign(attackerPk, id, ACTION_RELEASE, deadline);

        vm.prank(payee);
        vm.expectRevert(HandoverEscrow.BadAttestation.selector);
        escrow.release(id, deadline, badSig);

        assertEq(usdc.balanceOf(address(escrow)), TOTAL, "funds untouched");
        assertEq(uint8(escrow.stateOf(id)), uint8(HandoverEscrow.State.Funded));
    }

    function test_Release_RevertsWhenExpired() public {
        bytes32 id = keccak256("bid-E");
        _openAndFund(id, uint64(block.timestamp + 1 days));
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory sig = _sign(attestorPk, id, ACTION_RELEASE, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(HandoverEscrow.AttestationExpired.selector);
        escrow.release(id, deadline, sig);
    }

    function test_Release_RevertsOnWrongAction() public {
        // a REFUND-signed attestation must not authorize a RELEASE
        bytes32 id = keccak256("bid-F");
        _openAndFund(id, uint64(block.timestamp + 1 days));
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory refundSig = _sign(attestorPk, id, ACTION_REFUND, deadline);

        vm.expectRevert(HandoverEscrow.BadAttestation.selector);
        escrow.release(id, deadline, refundSig);
    }

    function test_Release_RevertsOnReplayToOtherEscrow() public {
        // an attestation for bid-G must not release bid-H
        bytes32 idG = keccak256("bid-G");
        bytes32 idH = keccak256("bid-H");
        _openAndFund(idG, uint64(block.timestamp + 1 days));
        _openAndFund(idH, uint64(block.timestamp + 1 days));
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory sigForG = _sign(attestorPk, idG, ACTION_RELEASE, deadline);

        vm.expectRevert(HandoverEscrow.BadAttestation.selector);
        escrow.release(idH, deadline, sigForG);
    }

    function test_DoubleRelease_Reverts() public {
        bytes32 id = keccak256("bid-I");
        _openAndFund(id, uint64(block.timestamp + 1 days));
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes memory sig = _sign(attestorPk, id, ACTION_RELEASE, deadline);

        escrow.release(id, deadline, sig);
        vm.expectRevert(HandoverEscrow.BadState.selector);
        escrow.release(id, deadline, sig);
    }

    function test_Reclaim_RevertsBeforeDeadline() public {
        bytes32 id = keccak256("bid-J");
        uint64 deadline = uint64(block.timestamp + 1 days);
        _openAndFund(id, deadline);

        vm.prank(payer);
        vm.expectRevert(HandoverEscrow.DeadlineNotPassed.selector);
        escrow.reclaim(id);
        assertEq(usdc.balanceOf(address(escrow)), TOTAL, "funds still locked");
    }

    function test_Open_OnlyOperator() public {
        vm.prank(attacker);
        vm.expectRevert(HandoverEscrow.NotOperator.selector);
        escrow.open(keccak256("x"), payer, payee, PAYEE_AMOUNT, FEE_AMOUNT, uint64(block.timestamp + 1 days));
    }

    function test_Open_RevertsOnDuplicate() public {
        bytes32 id = keccak256("bid-K");
        vm.startPrank(operator);
        escrow.open(id, payer, payee, PAYEE_AMOUNT, FEE_AMOUNT, uint64(block.timestamp + 1 days));
        vm.expectRevert(HandoverEscrow.BadState.selector);
        escrow.open(id, payer, payee, PAYEE_AMOUNT, FEE_AMOUNT, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_Fund_RevertsIfNotOpened() public {
        vm.prank(payer);
        vm.expectRevert(HandoverEscrow.BadState.selector);
        escrow.fund(keccak256("never-opened"));
    }

    function test_OwnerCannotWithdrawEscrowedFunds() public {
        // there is no function allowing the owner to move escrowed USDC out to itself.
        bytes32 id = keccak256("bid-L");
        _openAndFund(id, uint64(block.timestamp + 1 days));

        // precompute the (invalid) attestation BEFORE expectRevert, so the external
        // domainSeparator() read inside _sign isn't what expectRevert captures.
        uint64 dl = uint64(block.timestamp + 1);
        bytes memory badSig = _sign(attackerPk, id, ACTION_RELEASE, dl);

        // owner can only rotate roles; even pointing treasury at itself...
        vm.prank(owner);
        escrow.setTreasury(owner);

        // ...still cannot release without a valid attestor signature:
        vm.expectRevert(HandoverEscrow.BadAttestation.selector);
        escrow.release(id, dl, badSig);
        assertEq(usdc.balanceOf(address(escrow)), TOTAL);
    }

    // ---- fuzz: fee conservation ----

    function testFuzz_Release_ConservesFunds(uint256 payeeAmt, uint256 feeAmt) public {
        payeeAmt = bound(payeeAmt, 1, 1_000_000_000000); // up to $1M
        feeAmt = bound(feeAmt, 0, 1_000_000_000000);
        uint256 total = payeeAmt + feeAmt;

        bytes32 id = keccak256(abi.encode(payeeAmt, feeAmt));
        usdc.mint(payer, total); // ensure the payer can always cover the fuzzed total
        vm.prank(operator);
        escrow.open(id, payer, payee, payeeAmt, feeAmt, uint64(block.timestamp + 1 days));
        vm.startPrank(payer);
        usdc.approve(address(escrow), total);
        escrow.fund(id);
        vm.stopPrank();

        uint256 payeeBefore = usdc.balanceOf(payee);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        uint64 deadline = uint64(block.timestamp + 15 minutes);
        escrow.release(id, deadline, _sign(attestorPk, id, ACTION_RELEASE, deadline));

        // exact conservation: every base unit in comes back out to the right place
        assertEq(usdc.balanceOf(payee) - payeeBefore, payeeAmt);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, feeAmt);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
