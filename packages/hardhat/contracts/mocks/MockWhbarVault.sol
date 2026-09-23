// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The vault's surface, which only the position manager and a test call.
interface IMockWhbarVault {
    /// @notice Test helper with no counterpart on Hedera: pays `amount` of native HBAR out to `recipient`.
    function mockPayOut(address recipient, uint256 amount) external;
}

/// @title MockWhbarVault
/// @notice An original stand-in for the contract that holds wrapped HBAR, injected at its own address with
///         `hardhat_setCode`. It exists so that the position manager's `unwrapWHBAR` has somewhere to send the
///         wrapped token and somewhere for the native HBAR to come from, which is how the split collect delivers
///         HBAR rather than a token on Hedera.
/// @dev It models no wrapping: the HBAR it pays out is what a test funded it with, and the WHBAR it is sent is not
///      burnt. Nothing here guards who may ask for a payout, which is what makes it a mock and not a contract.
contract MockWhbarVault {
    receive() external payable {}

    function mockPayOut(address recipient, uint256 amount) external {
        require(address(this).balance >= amount, "MockWhbarVault: not enough HBAR wrapped");
        (bool sent, ) = recipient.call{ value: amount }("");
        require(sent, "MockWhbarVault: the recipient refused the HBAR");
    }
}
