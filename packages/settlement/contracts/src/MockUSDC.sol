// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Test-only USDC stand-in: 6 decimals, open mint, and EIP-3009
///      receiveWithAuthorization (mirroring real USDC, which supports it on Base).
///      NEVER deploy to mainnet.
contract MockUSDC is ERC20, EIP712 {
    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("Mock USD Coin", "USDC") EIP712("Mock USD Coin", "1") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Real USDC exposes version() (its EIP-712 domain version); the API
    ///         reads it on-chain to build funding authorizations, so mirror it.
    function version() external pure returns (string memory) {
        return "1";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice EIP-3009: move `value` from `from` to `to` using an offline signature.
    ///         Caller MUST be the payee (`to`) — front-running protection per spec.
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
    ) external {
        require(to == msg.sender, "EIP3009: caller must be the payee");
        require(block.timestamp > validAfter, "EIP3009: authorization not yet valid");
        require(block.timestamp < validBefore, "EIP3009: authorization expired");
        require(!authorizationState[from][nonce], "EIP3009: authorization used");

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
        require(ECDSA.recover(digest, v, r, s) == from, "EIP3009: invalid signature");

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
