// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IMockHederaTokenService } from "./MockHederaTokenService.sol";
import { IMockLpNft } from "./MockLpNft.sol";
import { IMockV2Pool } from "./MockV2Pool.sol";
import { IMockWhbarVault } from "./MockWhbarVault.sol";

/// @title MockPositionManager
/// @notice An original stand-in for the SaucerSwap V2 position manager, injected at the manager's own address with
///         `hardhat_setCode`, so that the library building the calls is exercised against the address book a real
///         transaction uses.
/// @dev It models no pool: no ticks, no curve, no fee growth. What it models is the set of **failures measured on
///      Hedera testnet**, because those are what a position library has to be written around:
///       - a burn while the manager holds no approval on the position NFT reverts `HederaFail(292)`, although both
///         simulators accept it;
///       - collecting both sides into the manager reverts `TransferFail(184)`, because the manager is associated
///         with the wrapped HBAR and not with the pool's other token;
///       - `multicall` re-throws any revert shorter than 68 bytes with no data at all, so the same failure reads as
///         `0x` when it is wrapped;
///       - a value that does not cover the mint fee reverts `MF()`, the periphery's own error.
///      The success path is the split collect: the wrapped HBAR is collected into the manager, `unwrapWHBAR` turns
///      it into native HBAR through the vault, and the other token is collected straight to the recipient.
///      `hardhat_setCode` copies runtime code only, so the manager has no constructor and a test calls
///      `mockConfigure` after the injection.
contract MockPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    address private constant HTS = address(0x167);
    int64 private constant SUCCESS = 22;
    /// @dev Stands for the account the network pays the mint fee to.
    address private constant FEE_SINK = address(0xFEE);

    address public pool;
    address public lpNft;
    address public whbarVault;
    address public token0;
    address public token1;
    uint24 public poolFee;
    uint256 public mintFeeTinybar;
    uint256 private nextSerial;
    mapping(uint256 tokenId => Position) private positionOf;

    error HederaFail(int256 responseCode);
    error TransferFail(int256 responseCode);
    error RespCode(int32 responseCode);
    error MF();

    event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1);

    /// @notice Test helper with no counterpart on testnet: the addresses and the fee this manager works with.
    function mockConfigure(
        address pool_,
        address lpNft_,
        address whbarVault_,
        address token0_,
        address token1_,
        uint24 poolFee_,
        uint256 mintFeeTinybar_,
        uint256 firstSerial
    ) external {
        pool = pool_;
        lpNft = lpNft_;
        whbarVault = whbarVault_;
        token0 = token0_;
        token1 = token1_;
        poolFee = poolFee_;
        mintFeeTinybar = mintFeeTinybar_;
        nextSerial = firstSerial;
    }

    function mint(
        MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        require(block.timestamp <= params.deadline, "Transaction too old");
        // The periphery takes the fee before it wraps anything, so a value that cannot pay both fails here and not
        // on the deposit: this is the MF the third-party transactions on testnet failed with most often.
        if (msg.value < params.amount0Desired + mintFeeTinybar) revert MF();
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert("Price slippage check");

        int64 responseCode = IMockHederaTokenService(HTS).transferToken(
            params.token1,
            msg.sender,
            pool,
            int64(uint64(amount1))
        );
        if (responseCode != SUCCESS) revert RespCode(int32(responseCode));

        _send(whbarVault, amount0);
        _send(FEE_SINK, mintFeeTinybar);

        liquidity = uint128(amount1);
        tokenId = nextSerial++;
        positionOf[tokenId] = Position({
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            amount0: amount0,
            amount1: amount1,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
        IMockLpNft(lpNft).mockMint(params.recipient, tokenId);
        emit IncreaseLiquidity(tokenId, liquidity, amount0, amount1);
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        require(block.timestamp <= params.deadline, "Transaction too old");
        _requireOwner(params.tokenId);
        Position storage position = positionOf[params.tokenId];
        require(position.liquidity >= params.liquidity && params.liquidity > 0, "Invalid liquidity");

        amount0 = (position.amount0 * params.liquidity) / position.liquidity;
        amount1 = (position.amount1 * params.liquidity) / position.liquidity;
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert("Price slippage check");

        position.amount0 -= amount0;
        position.amount1 -= amount1;
        position.liquidity -= params.liquidity;
        position.tokensOwed0 += uint128(amount0);
        position.tokensOwed1 += uint128(amount1);
        emit DecreaseLiquidity(params.tokenId, params.liquidity, amount0, amount1);
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        _requireOwner(params.tokenId);
        // A recipient of zero means the manager keeps the tokens, which is what makes the split collect possible
        // and what makes the Uniswap pattern fail: the manager cannot receive the pool's other token.
        address recipient = params.recipient == address(0) ? address(this) : params.recipient;
        Position storage position = positionOf[params.tokenId];
        amount0 = _atMost(position.tokensOwed0, params.amount0Max);
        amount1 = _atMost(position.tokensOwed1, params.amount1Max);

        position.tokensOwed0 -= uint128(amount0);
        position.tokensOwed1 -= uint128(amount1);
        // The pool is what moves the tokens, so a recipient that cannot receive one fails inside this call and the
        // reason that comes back is the pool's TransferFail.
        IMockV2Pool(pool).collect(recipient, uint128(amount0), uint128(amount1));
        emit Collect(params.tokenId, recipient, amount0, amount1);
    }

    function unwrapWHBAR(uint256 amountMinimum, address recipient) external payable {
        uint256 held = IMockHederaTokenService(HTS).balanceOf(token0, address(this));
        require(held >= amountMinimum, "Insufficient WHBAR");
        if (held == 0) return;
        int64 responseCode = IMockHederaTokenService(HTS).transferToken(
            token0,
            address(this),
            whbarVault,
            int64(uint64(held))
        );
        if (responseCode != SUCCESS) revert TransferFail(int256(responseCode));
        IMockWhbarVault(whbarVault).mockPayOut(recipient, held);
    }

    function burn(uint256 tokenId) external payable {
        address owner = _requireOwner(tokenId);
        Position storage position = positionOf[tokenId];
        require(position.liquidity == 0 && position.tokensOwed0 == 0 && position.tokensOwed1 == 0, "Not cleared");
        // The burn moves the position NFT back to the manager, and the token service refuses to move it without an
        // approval. Neither simulator checks that, which is why this shape costs real HBAR to discover.
        if (!IMockLpNft(lpNft).isApprovedForAll(owner, address(this))) revert HederaFail(292);
        IMockLpNft(lpNft).mockBurn(tokenId);
        delete positionOf[tokenId];
    }

    function positions(
        uint256 tokenId
    ) external view returns (address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128) {
        require(IMockLpNft(lpNft).ownerOf(tokenId) != address(0), "Invalid token ID");
        Position storage position = positionOf[tokenId];
        return (
            token0,
            token1,
            poolFee,
            position.tickLower,
            position.tickUpper,
            position.liquidity,
            0,
            0,
            position.tokensOwed0,
            position.tokensOwed1
        );
    }

    /// @notice The same sweep the manager performs on testnet: everything it holds goes to the caller, including
    ///         what an earlier caller left behind.
    function refundETH() external payable {
        if (address(this).balance > 0) _send(msg.sender, address(this).balance);
    }

    /// @notice The same observable rule as the manager's inherited multicall: an inner revert shorter than 68 bytes
    ///         is re-thrown with no data at all, which is why a failed position call reads as `0x` on the mirror.
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

    receive() external payable {}

    function _requireOwner(uint256 tokenId) private view returns (address owner) {
        owner = IMockLpNft(lpNft).ownerOf(tokenId);
        require(owner == msg.sender, "not authorized");
    }

    function _atMost(uint128 owed, uint128 maximum) private pure returns (uint256) {
        return owed < maximum ? owed : maximum;
    }

    function _send(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{ value: amount }("");
        require(sent, "the recipient refused the HBAR");
    }
}
