// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IMockHederaTokenService } from "./MockHederaTokenService.sol";
import { ISwapRouterExactInput } from "../interfaces/ISwapRouterExactInput.sol";

/// @title MockSwapRouter
/// @notice An original fixed-price stand-in for the SaucerSwap V2 router, injected at the router's own address with
///         `hardhat_setCode`, so that a consumer built with the real address book is what the tests exercise.
/// @dev It models no pool: no ticks, no curve, no fee growth, one constant price. What it does model is the set of
///      **failure shapes measured on Hedera testnet**, because those are what a consumer and an error decoder must
///      survive: a response code other than 22 comes back as the 36-byte custom error `TransferFail(int256)` or
///      `RespCode(int32)`, and `multicall` erases any revert shorter than 68 bytes, so the very same failure is
///      empty data when it is wrapped. `refundETH` is a sweep of the whole balance, as on testnet, and it can be
///      told to call back into its caller, which is how the consumer's re-entry guard is tested.
///      `hardhat_setCode` copies runtime code only, so the price and the output token are set by `mockConfigure`
///      after the injection instead of by a constructor.
contract MockSwapRouter {
    address private constant HTS = address(0x167);
    int64 private constant SUCCESS = 22;
    uint256 private constant PRICE_SCALE = 1e6;
    /// @dev Stands for the pool: the HBAR a swap spends leaves the router, so only the rest can be refunded.
    address private constant POOL = address(0xDEAD);

    address public tokenOut;
    /// @notice Units of `tokenOut` per tinybar, scaled by 1e6.
    uint256 public outPerTinybarE6;
    address private onRefundTarget;
    bytes private onRefundCall;

    error RespCode(int32 responseCode);
    error TransferFail(int256 responseCode);

    /// @notice Test helper with no counterpart on testnet: the price and the token this router pays out in.
    function mockConfigure(address tokenOut_, uint256 outPerTinybarE6_) external {
        tokenOut = tokenOut_;
        outPerTinybarE6 = outPerTinybarE6_;
    }

    /// @notice Test helper: make `refundETH` call `data` on `target` first, the way a router could call back.
    function mockCallOnRefund(address target, bytes calldata data) external {
        onRefundTarget = target;
        onRefundCall = data;
    }

    function quoteExactInput(bytes memory, uint256 amountIn) public view returns (uint256 amountOut) {
        return (amountIn * outPerTinybarE6) / PRICE_SCALE;
    }

    function exactInput(
        ISwapRouterExactInput.ExactInputParams calldata params
    ) external payable returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline, "Transaction too old");
        // The router pays in HBAR only while its balance covers amountIn; otherwise it pulls WHBAR from the payer,
        // who holds none, and the token service answers 178. That is the shape an unscaled value produces.
        if (address(this).balance < params.amountIn) revert RespCode(178);
        amountOut = quoteExactInput(params.path, params.amountIn);
        require(amountOut >= params.amountOutMinimum, "Too little received");
        (bool taken, ) = POOL.call{ value: params.amountIn }("");
        require(taken, "the pool did not take the HBAR");
        int64 responseCode = IMockHederaTokenService(HTS).transferToken(
            tokenOut,
            address(this),
            params.recipient,
            int64(uint64(amountOut))
        );
        if (responseCode != SUCCESS) revert TransferFail(int256(responseCode));
    }

    function refundETH() external payable {
        if (onRefundTarget != address(0)) {
            (bool answered, bytes memory answer) = onRefundTarget.call(onRefundCall);
            if (!answered) {
                assembly {
                    revert(add(answer, 0x20), mload(answer))
                }
            }
        }
        if (address(this).balance > 0) {
            (bool sent, ) = msg.sender.call{ value: address(this).balance }("");
            require(sent, "refund failed");
        }
    }

    /// @notice The same observable rule as the router's inherited multicall: an inner revert shorter than 68 bytes
    ///         is re-thrown with no data at all, which is why a failed swap reads as `0x` on the mirror node.
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 index = 0; index < data.length; index++) {
            (bool answered, bytes memory answer) = address(this).delegatecall(data[index]);
            if (!answered) {
                if (answer.length < 68) revert();
                assembly {
                    answer := add(answer, 0x04)
                }
                revert(abi.decode(answer, (string)));
            }
            results[index] = answer;
        }
    }
}
