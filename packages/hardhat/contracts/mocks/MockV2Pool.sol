// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IMockHederaTokenService } from "./MockHederaTokenService.sol";

/// @title The pool's surface, as the position manager uses it.
interface IMockV2Pool {
    function collect(address recipient, uint128 amount0, uint128 amount1) external;

    /// @notice Test helper with no counterpart on testnet: the two tokens this pool pays out in.
    function mockConfigure(address token0, address token1) external;
}

/// @title MockV2Pool
/// @notice An original stand-in for a SaucerSwap V2 pool, injected at the HBAR/SAUCE pool's own address with
///         `hardhat_setCode`. It holds the tokens and pays them out, which is the part that matters: the pool is
///         what calls the token service, so a recipient that cannot receive a token fails **here**, and the error a
///         caller sees is the pool's `TransferFail`, not the manager's.
/// @dev It models no curve, no tick and no fee growth, and it takes no deposit: a test credits it through the token
///      service. `hardhat_setCode` copies runtime code only, so the two tokens are set by `mockConfigure`.
contract MockV2Pool {
    address private constant HTS = address(0x167);
    int64 private constant SUCCESS = 22;

    address public token0;
    address public token1;

    error TransferFail(int256 responseCode);

    function mockConfigure(address token0_, address token1_) external {
        token0 = token0_;
        token1 = token1_;
    }

    function collect(address recipient, uint128 amount0, uint128 amount1) external {
        _pay(token0, recipient, amount0);
        _pay(token1, recipient, amount1);
    }

    function _pay(address token, address recipient, uint128 amount) private {
        if (amount == 0) return;
        int64 responseCode = IMockHederaTokenService(HTS).transferToken(
            token,
            address(this),
            recipient,
            int64(uint64(amount))
        );
        if (responseCode != SUCCESS) revert TransferFail(int256(responseCode));
    }
}
