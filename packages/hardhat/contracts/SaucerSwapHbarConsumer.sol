// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHtsAssociate } from "./interfaces/IHtsAssociate.sol";
import { IHtsFungibleToken } from "./interfaces/IHtsFungibleToken.sol";
import { ISwapRouterExactInput } from "./interfaces/ISwapRouterExactInput.sol";

/// @title SaucerSwapHbarConsumer
/// @author This repository; original work under the MIT licence.
/// @notice A contract that swaps the HBAR sent with a call for one HTS token on SaucerSwap V2 and keeps the tokens.
///         It is the smallest useful on-chain consumer of the protocol: one pool, one direction, no routing.
///
/// @dev Two Hedera behaviours decide the shape of this contract.
///
///      **HBAR has two units.** Inside the EVM every HBAR amount is tinybar, eight decimals: `msg.value`,
///      `address(this).balance`, `amountInTinybar` and what `receive()` is credited. A JSON-RPC caller does not sign
///      tinybar: it signs `value` in weibar, tinybar multiplied by 10^10, and the network divides it before this
///      contract runs. One HBAR is `1000000000000000000` in the signed transaction and `100000000` here. A caller
///      that signs `100000000` is refused by the relay ("Value can't be non-zero and less than 10_000_000_000 wei
///      which is 1 tinybar"), and one that signs the right value but passes the weibar figure as `amountInTinybar`
///      is refused here, by `ValueBelowAmountIn`. `packages/nextjs/lib/hedera/units.ts` owns the conversion on the
///      caller's side, and `payable()` there is the only place the app writes a transaction value.
///
///      **A token must be able to reach an account before it is sent.** A contract that has never held `tokenOut`
///      cannot receive it, and the router's transfer then fails with the token service's code 184 rather than with
///      a revert string. The constructor therefore associates this contract with `tokenOut` through the system
///      contract at `0x167` and refuses to exist if the service answers anything but 22: the deployer pays for the
///      relation once, at deployment, instead of every swap paying for it. The association roughly doubles what the
///      deployment costs; what it cost for this repository's own deployment is recorded in `docs/evidence/`, and
///      `docs/hedera-behaviour.md` explains why a failed association is still a successful transaction.
contract SaucerSwapHbarConsumer {
    /// @notice The Hedera Token Service system contract. Every HTS operation of this contract goes through it.
    address public constant HTS = address(0x167);

    /// @dev The service's response codes this contract reads. It answers with one instead of reverting.
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;
    /// @dev What `_associate` reports when the service answered something that is not a response code at all.
    int64 private constant HTS_NO_RESPONSE_CODE = type(int64).min;

    /// @notice Who may call `associate`, `withdrawToken` and `withdrawHbar`: whoever deployed this contract.
    address public immutable owner;
    /// @notice The SaucerSwap V2 router this contract swaps through.
    ISwapRouterExactInput public immutable router;
    /// @notice The HTS token that stands for HBAR in a swap path; the router wraps and unwraps it itself.
    address public immutable whbar;
    /// @notice The token every swap of this contract buys, and the one the constructor associated.
    address public immutable tokenOut;
    /// @notice The pool's fee, in hundredths of a basis point: 3000 is the 0.30 % pool.
    uint24 public immutable poolFee;

    /// @dev 1 while a swap is running, so that the router cannot call back into one.
    uint256 private swapping;

    event Associated(address indexed token, int64 responseCode);
    event Swapped(address indexed caller, uint256 amountInTinybar, uint256 amountOut, uint256 refundedTinybar);

    error NotOwner(address caller);
    /// @param responseCode what the token service answered; `type(int64).min` when it answered no code at all.
    error AssociationFailed(int64 responseCode);
    error ValueBelowAmountIn(uint256 valueTinybar, uint256 amountInTinybar);
    error MinimumOutIsZero();
    error RouterReentered();
    error HbarTransferFailed(address to, uint256 amountTinybar);
    error TokenTransferFailed(address to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @dev The router is third-party code, and this contract holds HBAR while it runs.
    modifier noReentry() {
        if (swapping == 1) revert RouterReentered();
        swapping = 1;
        _;
        swapping = 0;
    }

    /// @param router_ the SaucerSwap V2 SwapRouter
    /// @param whbar_ the WHBAR *token*, the one a swap path names, not the contract that holds the wrapped HBAR
    /// @param tokenOut_ the HTS token this contract buys and holds
    /// @param poolFee_ the fee of the pool that pairs the two
    constructor(address router_, address whbar_, address tokenOut_, uint24 poolFee_) {
        owner = msg.sender;
        router = ISwapRouterExactInput(router_);
        whbar = whbar_;
        tokenOut = tokenOut_;
        poolFee = poolFee_;
        int64 responseCode = _associate(tokenOut_);
        // 194 would mean the relation already existed, which a contract created by this transaction cannot have.
        if (responseCode != HTS_SUCCESS) revert AssociationFailed(responseCode);
    }

    /// @notice Receives the change of a swap, which the router sends back with `refundETH`.
    receive() external payable {}

    /// @notice Associates this contract with `tokenOut` again, for a token whose relation was removed since.
    /// @dev Idempotent: 194 means the relation is already there, which is the state the caller wanted.
    /// @return responseCode 22 or 194; anything else reverts with `AssociationFailed`.
    function associate() external onlyOwner returns (int64 responseCode) {
        responseCode = _associate(tokenOut);
        if (responseCode != HTS_SUCCESS && responseCode != HTS_TOKEN_ALREADY_ASSOCIATED) {
            revert AssociationFailed(responseCode);
        }
    }

    /// @notice Swaps `amountInTinybar` of the HBAR sent with this call for `tokenOut`, which this contract keeps.
    /// @param amountInTinybar how much of `msg.value` to swap, in tinybar. Send more than this to leave a margin
    ///        for the price moving; everything the swap does not spend goes back to the caller in the same call.
    /// @param amountOutMinimum the smallest output the caller accepts, in the token's smallest unit. It has no
    ///        default here: a zero minimum accepts any price, so this contract refuses it. Take the number from
    ///        QuoterV2 and subtract the slippage the caller is willing to bear.
    /// @param deadline unix seconds after which the router refuses the swap.
    /// @return amountOut what the pool paid, now held by this contract.
    /// @return refundedTinybar what went back to the caller.
    function swapExactHbarForToken(
        uint256 amountInTinybar,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external payable noReentry returns (uint256 amountOut, uint256 refundedTinybar) {
        if (amountOutMinimum == 0) revert MinimumOutIsZero();
        if (msg.value < amountInTinybar) revert ValueBelowAmountIn(msg.value, amountInTinybar);
        // What this contract held before the call. Anything above it afterwards belongs to the caller.
        uint256 heldBefore = address(this).balance - msg.value;

        amountOut = router.exactInput{ value: msg.value }(
            ISwapRouterExactInput.ExactInputParams({
                path: abi.encodePacked(whbar, poolFee, tokenOut),
                recipient: address(this),
                deadline: deadline,
                amountIn: amountInTinybar,
                amountOutMinimum: amountOutMinimum
            })
        );
        // Without this the change stays in the router, where the next caller's refundETH sweeps it away.
        router.refundETH();

        refundedTinybar = address(this).balance - heldBefore;
        emit Swapped(msg.sender, amountInTinybar, amountOut, refundedTinybar);
        // Last, and after the event: sending HBAR hands control to the caller.
        if (refundedTinybar > 0) _sendHbar(msg.sender, refundedTinybar);
    }

    /// @notice Sends tokens this contract bought to `to`.
    function withdrawToken(address to, uint256 amount) external onlyOwner {
        if (!IHtsFungibleToken(tokenOut).transfer(to, amount)) revert TokenTransferFailed(to, amount);
    }

    /// @notice Sends HBAR this contract holds to `to`, in tinybar.
    function withdrawHbar(address to, uint256 amountTinybar) external onlyOwner {
        _sendHbar(to, amountTinybar);
    }

    /// @notice What this contract holds of `tokenOut`, in the token's smallest unit.
    function tokenBalance() external view returns (uint256) {
        return IHtsFungibleToken(tokenOut).balanceOf(address(this));
    }

    /// @dev The token service answers a code; a call that reverts or returns something else is reported as
    ///      `HTS_NO_RESPONSE_CODE` rather than read as a success.
    function _associate(address token) private returns (int64 responseCode) {
        (bool answered, bytes memory answer) = HTS.call(
            abi.encodeCall(IHtsAssociate.associateToken, (address(this), token))
        );
        responseCode = answered && answer.length == 32 ? abi.decode(answer, (int64)) : HTS_NO_RESPONSE_CODE;
        emit Associated(token, responseCode);
    }

    function _sendHbar(address to, uint256 amountTinybar) private {
        (bool sent, ) = payable(to).call{ value: amountTinybar }("");
        if (!sent) revert HbarTransferFailed(to, amountTinybar);
    }
}
