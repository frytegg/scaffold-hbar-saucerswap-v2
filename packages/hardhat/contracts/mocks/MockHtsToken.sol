// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IMockHederaTokenService } from "./MockHederaTokenService.sol";

/// @title MockHtsToken
/// @notice An original stand-in for the ERC-20 facade that every HTS token answers at its own address, injected at
///         the token's address with `hardhat_setCode`.
/// @dev The facade owns no ledger: it asks the token service, as on Hedera, and names the token by its own address.
///      The same balance is therefore visible through the facade and through the service, and a transfer the
///      service refuses comes back as `false` here rather than as a revert.
contract MockHtsToken {
    address private constant HTS = address(0x167);
    int64 private constant SUCCESS = 22;

    function balanceOf(address account) external view returns (uint256) {
        return IMockHederaTokenService(HTS).balanceOf(address(this), account);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        int64 responseCode = IMockHederaTokenService(HTS).transferToken(
            address(this),
            msg.sender,
            to,
            int64(uint64(amount))
        );
        return responseCode == SUCCESS;
    }
}
