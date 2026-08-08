// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HandoverEscrow} from "../src/HandoverEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Drives random valid lifecycles and tracks ghost accounting.
contract Handler is Test {
    HandoverEscrow public escrow;
    MockUSDC public usdc;
    uint256 attestorPk;
    address operator;

    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;

    bytes32[] public ids;
    mapping(bytes32 => bool) public live; // funded and not yet terminal
    mapping(bytes32 => uint256) public totalOf;
    mapping(bytes32 => address) public payerOf;

    uint8 constant RELEASE = 1;
    uint8 constant REFUND = 2;
    bytes32 constant TYPEHASH =
        keccak256("HandoverAttestation(bytes32 escrowId,uint8 action,uint64 deadline)");

    constructor(HandoverEscrow _escrow, MockUSDC _usdc, uint256 _attestorPk, address _operator) {
        escrow = _escrow;
        usdc = _usdc;
        attestorPk = _attestorPk;
        operator = _operator;
    }

    function _sign(bytes32 id, uint8 action, uint64 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, id, action, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function open(uint256 pAmt, uint256 fAmt, uint256 seed) public {
        pAmt = bound(pAmt, 1, 1_000_000_000000);
        fAmt = bound(fAmt, 0, 1_000_000_000000);
        uint256 total = pAmt + fAmt;
        bytes32 id = keccak256(abi.encode(seed, ids.length, "id"));
        if (uint8(escrow.stateOf(id)) != uint8(HandoverEscrow.State.None)) return;

        address payer = address(uint160(uint256(keccak256(abi.encode("payer", seed))) | 1));
        address payee = address(uint160(uint256(keccak256(abi.encode("payee", seed))) | 1));

        vm.prank(operator);
        escrow.open(id, payer, payee, pAmt, fAmt, uint64(block.timestamp + 1 days));
        usdc.mint(payer, total);
        vm.startPrank(payer);
        usdc.approve(address(escrow), total);
        escrow.fund(id);
        vm.stopPrank();

        ids.push(id);
        live[id] = true;
        totalOf[id] = total;
        payerOf[id] = payer;
        ghostDeposited += total;
    }

    function release(uint256 idx) public {
        if (ids.length == 0) return;
        bytes32 id = ids[idx % ids.length];
        if (!live[id]) return;
        uint64 dl = uint64(block.timestamp + 15 minutes);
        escrow.release(id, dl, _sign(id, RELEASE, dl));
        live[id] = false;
        ghostPaidOut += totalOf[id];
    }

    function refund(uint256 idx) public {
        if (ids.length == 0) return;
        bytes32 id = ids[idx % ids.length];
        if (!live[id]) return;
        uint64 dl = uint64(block.timestamp + 15 minutes);
        vm.prank(operator);
        escrow.refund(id, dl, _sign(id, REFUND, dl));
        live[id] = false;
        ghostPaidOut += totalOf[id];
    }

    function reclaim(uint256 idx, uint256 skip) public {
        if (ids.length == 0) return;
        bytes32 id = ids[idx % ids.length];
        if (!live[id]) return;
        vm.warp(block.timestamp + bound(skip, 1 days + 1, 3 days));
        vm.prank(payerOf[id]);
        escrow.reclaim(id);
        live[id] = false;
        ghostPaidOut += totalOf[id];
    }
}

contract HandoverEscrowInvariant is StdInvariant, Test {
    HandoverEscrow escrow;
    MockUSDC usdc;
    Handler handler;

    function setUp() public {
        (address attestor, uint256 attestorPk) = makeAddrAndKey("attestor");
        usdc = new MockUSDC();
        escrow = new HandoverEscrow(
            address(usdc), makeAddr("treasury"), makeAddr("operator"), attestor, makeAddr("owner")
        );
        handler = new Handler(escrow, usdc, attestorPk, makeAddr("operator"));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = Handler.open.selector;
        selectors[1] = Handler.release.selector;
        selectors[2] = Handler.refund.selector;
        selectors[3] = Handler.reclaim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// The escrow contract can never hold more or less than what is owed:
    /// balance == total ever deposited - total ever paid out.
    function invariant_FundConservation() public view {
        assertEq(
            usdc.balanceOf(address(escrow)),
            handler.ghostDeposited() - handler.ghostPaidOut(),
            "escrow balance must equal deposited minus paid out"
        );
    }
}
