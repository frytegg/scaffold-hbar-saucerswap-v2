// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The mock token service's surface, including the helper that only a test calls.
interface IMockHederaTokenService {
    function associateToken(address account, address token) external returns (int64 responseCode);

    function transferToken(
        address token,
        address sender,
        address recipient,
        int64 amount
    ) external returns (int64 responseCode);

    function isAssociated(address token, address account) external view returns (bool);

    function balanceOf(address token, address account) external view returns (uint256);

    /// @notice Test helper with no counterpart on Hedera: associates `account` with `token` and credits it.
    function mockCredit(address token, address account, uint256 amount) external;

    /// @notice Test helper with no counterpart on Hedera: makes associateToken answer `length` bytes, not a code.
    function mockAnswerLength(uint256 length) external;
}

/// @title MockHederaTokenService
/// @notice An original stand-in for the Hedera Token Service system contract, injected at address `0x167` with
///         `hardhat_setCode`. It models the two behaviours that decide how a consumer and an error decoder have to
///         be written, and that a fork of Hedera gets wrong: the service **answers a response code** instead of
///         reverting, so a caller that ignores the return value records a successful transaction for an operation
///         that did nothing; and it **enforces association**, so a token cannot reach an account that has never
///         held it.
/// @dev `hardhat_setCode` copies runtime code only, so nothing here may depend on a constructor: a test credits
///      balances with `mockCredit` after the injection. Only what an association and an HBAR-in swap need is
///      modelled. There are no keys, fees, expiry, custom fees or allowances here; the allowance behaviour is
///      covered offline by the relay answers captured in `packages/nextjs/lib/hedera/__tests__/fixtures/`.
contract MockHederaTokenService {
    int64 private constant SUCCESS = 22;
    int64 private constant INSUFFICIENT_TOKEN_BALANCE = 178;
    int64 private constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 private constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    mapping(address token => mapping(address account => bool)) private associated;
    mapping(address token => mapping(address account => uint256)) private balances;
    /// @dev 0 answers a response code, as the real service does. Anything else answers that many bytes instead.
    uint256 private answerLength;

    /// @dev The real service needs the account's own signature; a contract gives it by passing its own address.
    function associateToken(address account, address token) external returns (int64 responseCode) {
        require(msg.sender == account, "MockHederaTokenService: only self-association is modelled");
        if (answerLength != 0) {
            uint256 length = answerLength;
            // Not a response code: a caller that reads 32 bytes out of it reads something the ledger never said.
            assembly {
                return(0x00, length)
            }
        }
        if (associated[token][account]) return TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
        associated[token][account] = true;
        return SUCCESS;
    }

    /// @dev `sender` must be the caller, or the token's own facade passing on a `transfer` its holder made.
    function transferToken(
        address token,
        address sender,
        address recipient,
        int64 amount
    ) external returns (int64 responseCode) {
        require(amount >= 0, "MockHederaTokenService: negative amounts are not modelled");
        require(msg.sender == sender || msg.sender == token, "MockHederaTokenService: allowances are not modelled");
        uint256 moved = uint256(uint64(amount));
        if (!associated[token][recipient]) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        if (balances[token][sender] < moved) return INSUFFICIENT_TOKEN_BALANCE;
        balances[token][sender] -= moved;
        balances[token][recipient] += moved;
        return SUCCESS;
    }

    function isAssociated(address token, address account) external view returns (bool) {
        return associated[token][account];
    }

    function balanceOf(address token, address account) external view returns (uint256) {
        return balances[token][account];
    }

    function mockCredit(address token, address account, uint256 amount) external {
        associated[token][account] = true;
        balances[token][account] += amount;
    }

    function mockAnswerLength(uint256 length) external {
        answerLength = length;
    }
}
