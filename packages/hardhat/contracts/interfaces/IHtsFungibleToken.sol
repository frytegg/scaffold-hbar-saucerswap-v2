// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The part of the ERC-20 facade of an HTS token that this project's contracts use.
/// @notice Every HTS fungible token answers the ERC-20 functions at its own address, so a contract moves one with
///         the calls below and never through the token service. Written from the ERC-20 shape, copied from nothing.
interface IHtsFungibleToken {
    /// @return the balance in the token's smallest unit (SAUCE has 6 decimals, so 1 SAUCE is 1000000).
    function balanceOf(address account) external view returns (uint256);

    /// @return whether the transfer happened. The facade answers false instead of reverting on some refusals.
    function transfer(address to, uint256 amount) external returns (bool);
}
