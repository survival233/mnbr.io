// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev EIP-3009 surface of USDC (supported by native USDC on Base).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @title HandoverEscrow
 * @notice Single-token (USDC) escrow whose release is gated by an off-chain
 *         EIP-712 attestation signed by Manebra's backend AFTER the traveler
 *         confirms the 6-digit handover code. The on-chain state machine mirrors
 *         the off-chain bid state machine:
 *           None -> Opened -> Funded -> (Released | Refunded)
 *         Terminal states are sealed; escrowId (== bid id) is single-use.
 *
 * @dev    NON-CUSTODY INVARIANT: once funded, an escrow's USDC can only ever move
 *         to one of three addresses fixed at open() time:
 *           - payee    (traveler)  on release
 *           - treasury (Manebra)   on release, commission only
 *           - payer    (shopper)   on refund or reclaim
 *         No owner/operator/attestor key can redirect funds elsewhere or withdraw
 *         them. reclaim() lets the payer always recover funds after the deadline
 *         even if Manebra's signer disappears -> funds can never be trapped.
 *
 *         Money math is server-authoritative: payeeAmount and feeAmount come from
 *         computeFees() in the shared package and are passed into open() by the
 *         backend. The contract never computes a split.
 */
contract HandoverEscrow is EIP712, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Opened,
        Funded,
        Released,
        Refunded
    }

    struct Escrow {
        address payer; // shopper
        address payee; // traveler
        uint256 payeeAmount; // subtotal (item + traveler fee), USDC base units (6 dp)
        uint256 feeAmount; // Manebra commission, USDC base units (6 dp)
        uint64 refundDeadline; // unix seconds; after this the payer may reclaim()
        State state;
    }

    IERC20 public immutable usdc;
    address public treasury; // commission sink
    address public operator; // backend key allowed to open() escrows
    address public attestor; // backend key whose signature releases/refunds

    mapping(bytes32 => Escrow) public escrows;

    // keccak256("HandoverAttestation(bytes32 escrowId,uint8 action,uint64 deadline)")
    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("HandoverAttestation(bytes32 escrowId,uint8 action,uint64 deadline)");

    uint8 private constant ACTION_RELEASE = 1;
    uint8 private constant ACTION_REFUND = 2;

    event EscrowOpened(
        bytes32 indexed escrowId,
        address indexed payer,
        address indexed payee,
        uint256 payeeAmount,
        uint256 feeAmount,
        uint64 refundDeadline
    );
    event EscrowFunded(bytes32 indexed escrowId, uint256 total);
    event EscrowReleased(bytes32 indexed escrowId, uint256 toPayee, uint256 toTreasury);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 toPayer);
    event OperatorUpdated(address operator);
    event AttestorUpdated(address attestor);
    event TreasuryUpdated(address treasury);

    error NotOperator();
    error BadState();
    error ZeroAddress();
    error AttestationExpired();
    error BadAttestation();
    error DeadlineNotPassed();

    constructor(
        address _usdc,
        address _treasury,
        address _operator,
        address _attestor,
        address _owner
    ) EIP712("ManebraHandoverEscrow", "1") Ownable(_owner) {
        if (
            _usdc == address(0) || _treasury == address(0) || _operator == address(0)
                || _attestor == address(0)
        ) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
        operator = _operator;
        attestor = _attestor;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // --- role rotation (owner can rotate signers, never touch escrowed funds) ---

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    function setAttestor(address _attestor) external onlyOwner {
        if (_attestor == address(0)) revert ZeroAddress();
        attestor = _attestor;
        emit AttestorUpdated(_attestor);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    // --- lifecycle ---

    /// @notice Backend records server-authored terms. escrowId is the bid id (bytes32).
    function open(
        bytes32 escrowId,
        address payer,
        address payee,
        uint256 payeeAmount,
        uint256 feeAmount,
        uint64 refundDeadline
    ) external onlyOperator {
        if (escrows[escrowId].state != State.None) revert BadState();
        if (payer == address(0) || payee == address(0)) revert ZeroAddress();
        escrows[escrowId] = Escrow({
            payer: payer,
            payee: payee,
            payeeAmount: payeeAmount,
            feeAmount: feeAmount,
            refundDeadline: refundDeadline,
            state: State.Opened
        });
        emit EscrowOpened(escrowId, payer, payee, payeeAmount, feeAmount, refundDeadline);
    }

    /// @notice Payer (shopper agent wallet) funds pre-committed terms. Requires prior USDC approve().
    function fund(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Opened) revert BadState();
        e.state = State.Funded;
        uint256 total = e.payeeAmount + e.feeAmount;
        usdc.safeTransferFrom(msg.sender, address(this), total);
        emit EscrowFunded(escrowId, total);
    }

    /// @notice GASLESS funding: the payer signs an EIP-3009 ReceiveWithAuthorization
    ///         offline (no ETH, no approve tx) and ANY relayer submits it. The token
    ///         enforces payee==this contract, so the authorization cannot be diverted;
    ///         we additionally bind it to the escrow's recorded payer and exact total.
    function fundWithAuthorization(
        bytes32 escrowId,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Opened) revert BadState();
        e.state = State.Funded;
        uint256 total = e.payeeAmount + e.feeAmount;
        IERC3009(address(usdc)).receiveWithAuthorization(
            e.payer, address(this), total, validAfter, validBefore, nonce, v, r, s
        );
        emit EscrowFunded(escrowId, total);
    }

    /// @notice Release to traveler + commission to treasury, gated by a handover attestation.
    ///         Permissionless to submit: anyone holding a valid attestation may relay it
    ///         (e.g. the traveler's own agent), removing Manebra from the release tx path.
    function release(bytes32 escrowId, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Funded) revert BadState();
        _verify(escrowId, ACTION_RELEASE, deadline, signature);

        e.state = State.Released;
        uint256 toPayee = e.payeeAmount;
        uint256 toTreasury = e.feeAmount;
        usdc.safeTransfer(e.payee, toPayee);
        if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);
        emit EscrowReleased(escrowId, toPayee, toTreasury);
    }

    /// @notice Full refund to shopper (cancel-before-purchase or admin-resolved dispute),
    ///         gated by a refund attestation. Manebra forgoes commission on refund.
    function refund(bytes32 escrowId, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Funded) revert BadState();
        _verify(escrowId, ACTION_REFUND, deadline, signature);

        e.state = State.Refunded;
        uint256 toPayer = e.payeeAmount + e.feeAmount;
        usdc.safeTransfer(e.payer, toPayer);
        emit EscrowRefunded(escrowId, toPayer);
    }

    /// @notice Trustless backstop: after refundDeadline the payer can always recover funds
    ///         with no attestation. Guarantees Manebra can never permanently trap money.
    function reclaim(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Funded) revert BadState();
        if (block.timestamp <= e.refundDeadline) revert DeadlineNotPassed();

        e.state = State.Refunded;
        uint256 toPayer = e.payeeAmount + e.feeAmount;
        usdc.safeTransfer(e.payer, toPayer);
        emit EscrowRefunded(escrowId, toPayer);
    }

    // --- views ---

    function stateOf(bytes32 escrowId) external view returns (State) {
        return escrows[escrowId].state;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --- internal ---

    function _verify(bytes32 escrowId, uint8 action, uint64 deadline, bytes calldata signature)
        internal
        view
    {
        if (block.timestamp > deadline) revert AttestationExpired();
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, escrowId, action, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != attestor) revert BadAttestation();
    }
}
