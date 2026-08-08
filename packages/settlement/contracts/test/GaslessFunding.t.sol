// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HandoverEscrow} from "../src/HandoverEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract GaslessFundingTest is Test {
    HandoverEscrow escrow;
    MockUSDC usdc;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address payee = makeAddr("payee");
    address relayer = makeAddr("relayer"); // pays gas; can be anyone
    uint256 payerPk;
    address payer; // the shopper's agent wallet — holds ZERO ETH
    uint256 attackerPk;
    address attacker;
    uint256 attestorPk;
    address attestor;

    uint256 constant PAYEE_AMOUNT = 120_000000;
    uint256 constant FEE_AMOUNT = 18_000000;
    uint256 constant TOTAL = PAYEE_AMOUNT + FEE_AMOUNT;

    function setUp() public {
        (payer, payerPk) = makeAddrAndKey("payer");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        (attestor, attestorPk) = makeAddrAndKey("attestor");
        usdc = new MockUSDC();
        escrow = new HandoverEscrow(address(usdc), treasury, operator, attestor, owner);
        usdc.mint(payer, TOTAL * 3);
        // deliberately: payer gets NO ether. vm.deal(payer, 0) is the default.
        assertEq(payer.balance, 0, "payer must hold zero ETH");
    }

    function _signAuth(uint256 pk, address from, uint256 value, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(escrow),
                value,
                uint256(0), // validAfter
                block.timestamp + 1 hours, // validBefore
                nonce
            )
        );
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Mock USD Coin")),
                keccak256(bytes("1")),
                block.chainid,
                address(usdc)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _open(bytes32 id) internal {
        vm.prank(operator);
        escrow.open(id, payer, payee, PAYEE_AMOUNT, FEE_AMOUNT, uint64(block.timestamp + 1 days));
    }

    function test_GaslessFund_PayerNeverTouchesChain() public {
        bytes32 id = keccak256("bid-G1");
        _open(id);
        bytes32 nonce = keccak256("auth-1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(payerPk, payer, TOTAL, nonce);

        // relayer submits and pays gas; the payer sent zero transactions
        vm.prank(relayer);
        escrow.fundWithAuthorization(id, 0, block.timestamp + 1 hours, nonce, v, r, s);

        assertEq(usdc.balanceOf(address(escrow)), TOTAL, "escrow funded");
        assertEq(uint8(escrow.stateOf(id)), uint8(HandoverEscrow.State.Funded));
        assertEq(payer.balance, 0, "payer still holds zero ETH");
    }

    function test_GaslessFund_RejectsNonPayerSignature() public {
        bytes32 id = keccak256("bid-G2");
        _open(id);
        bytes32 nonce = keccak256("auth-2");
        usdc.mint(attacker, TOTAL);
        // attacker signs an authorization for THEIR funds — but escrow pulls from e.payer,
        // so the recovered signer won't match `from` and the token rejects it.
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(attackerPk, payer, TOTAL, nonce);

        vm.prank(relayer);
        vm.expectRevert(bytes("EIP3009: invalid signature"));
        escrow.fundWithAuthorization(id, 0, block.timestamp + 1 hours, nonce, v, r, s);
    }

    function test_GaslessFund_NonceReplayAcrossEscrowsRejected() public {
        bytes32 id1 = keccak256("bid-G3a");
        bytes32 id2 = keccak256("bid-G3b");
        _open(id1);
        _open(id2);
        bytes32 nonce = keccak256("auth-3");
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(payerPk, payer, TOTAL, nonce);

        vm.prank(relayer);
        escrow.fundWithAuthorization(id1, 0, block.timestamp + 1 hours, nonce, v, r, s);

        // same signed authorization replayed against a second escrow must fail
        vm.prank(relayer);
        vm.expectRevert(bytes("EIP3009: authorization used"));
        escrow.fundWithAuthorization(id2, 0, block.timestamp + 1 hours, nonce, v, r, s);
    }

    function test_DirectReceiveByAttackerRejected() public {
        // the token's payee==caller rule: an attacker can't submit the payer's
        // authorization to pull funds anywhere but the escrow contract itself.
        bytes32 nonce = keccak256("auth-4");
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(payerPk, payer, TOTAL, nonce);

        vm.prank(attacker);
        vm.expectRevert(bytes("EIP3009: caller must be the payee"));
        usdc.receiveWithAuthorization(payer, address(escrow), TOTAL, 0, block.timestamp + 1 hours, nonce, v, r, s);
    }

    function test_GaslessFund_ExpiredAuthorizationRejected() public {
        bytes32 id = keccak256("bid-G5");
        _open(id);
        bytes32 nonce = keccak256("auth-5");
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(payerPk, payer, TOTAL, nonce);

        vm.warp(block.timestamp + 2 hours); // past validBefore
        vm.prank(relayer);
        vm.expectRevert(bytes("EIP3009: authorization expired"));
        escrow.fundWithAuthorization(id, 0, block.timestamp - 1 hours, nonce, v, r, s);
    }

    function test_GaslessFund_FullLifecycleToRelease() public {
        // zero-ETH shopper funds gaslessly; attestation releases to traveler + treasury
        bytes32 id = keccak256("bid-G6");
        _open(id);
        bytes32 nonce = keccak256("auth-6");
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(payerPk, payer, TOTAL, nonce);
        vm.prank(relayer);
        escrow.fundWithAuthorization(id, 0, block.timestamp + 1 hours, nonce, v, r, s);

        uint64 deadline = uint64(block.timestamp + 15 minutes);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("HandoverAttestation(bytes32 escrowId,uint8 action,uint64 deadline)"), id, uint8(1), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(attestorPk, digest);

        vm.prank(relayer);
        escrow.release(id, deadline, abi.encodePacked(ar, as_, av));

        assertEq(usdc.balanceOf(payee), PAYEE_AMOUNT);
        assertEq(usdc.balanceOf(treasury), FEE_AMOUNT);
        assertEq(payer.balance, 0, "payer never held ETH end-to-end");
    }
}
