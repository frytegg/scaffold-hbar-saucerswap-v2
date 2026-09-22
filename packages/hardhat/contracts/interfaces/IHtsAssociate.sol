// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The one Hedera Token Service call this project's own contracts make.
/// @notice Written from the function shape of the system contract at address 0x167, not copied from any source file.
///         The service answers with a response code instead of reverting, so a caller that ignores the return value
///         records a successful transaction for an operation that did nothing.
interface IHtsAssociate {
    /// @param account the account or contract that will be able to hold `token`; it has to authorise the call,
    ///        which a contract does by passing its own address
    /// @param token the HTS token's address in EVM form
    /// @return responseCode 22 (SUCCESS) when the relation was created, 194 when it already existed, and one of the
    ///         service's other codes otherwise. The transaction itself succeeds in every one of those cases.
    function associateToken(address account, address token) external returns (int64 responseCode);
}
