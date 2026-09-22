// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The two SaucerSwap V2 router functions a single-pool HBAR swap needs.
/// @notice Written from the deployed router's function shapes on Hedera testnet (0.0.1414040). No SaucerSwap or
///         Uniswap source file is imported, copied or vendored anywhere in this repository.
interface ISwapRouterExactInput {
    /// @param path the pools to cross, packed as token, fee, token (and so on for a multi-hop path)
    /// @param recipient who receives the output token; it must be able to hold that token already
    /// @param deadline unix seconds after which the router refuses the swap
    /// @param amountIn the input amount in its own smallest unit: tinybar when the input is HBAR
    /// @param amountOutMinimum the smallest output the caller accepts; 0 accepts any price
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` along `path`. Paying in HBAR means sending it as the call's value.
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

    /// @notice Sends the router's whole HBAR balance to the caller, which is how an HBAR swap gets its change back.
    /// @dev It is a sweep, not a per-caller refund: it pays out whatever the router holds at that moment.
    function refundETH() external payable;
}
