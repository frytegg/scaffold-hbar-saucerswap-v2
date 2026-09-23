// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The position NFT facade's surface, including the helpers only a test calls.
interface IMockLpNft {
    function ownerOf(uint256 serial) external view returns (address);

    function isApprovedForAll(address owner, address operator) external view returns (bool);

    function setApprovalForAll(address operator, bool approved) external;

    /// @notice Test helper with no counterpart on Hedera: gives `to` a serial without a token service behind it.
    function mockMint(address to, uint256 serial) external;

    /// @notice Test helper with no counterpart on Hedera: the manager's burn moves the serial back and deletes it.
    function mockBurn(uint256 serial) external;
}

/// @title MockLpNft
/// @notice An original stand-in for the ERC-721 facade of the HTS token that holds SaucerSwap V2 positions,
///         injected at that token's own address with `hardhat_setCode`.
/// @dev It models the two things the position manager reads and the one thing a UI cannot work out for itself:
///      who owns a serial, and whether the owner has approved the manager to move it. The approval lives here, on
///      the token's facade, because that is where the transaction that granted it on testnet was sent.
///      There is no enumeration, exactly as on Hedera: nothing here can list the serials an account holds, which is
///      why `packages/nextjs/lib/hedera/positionReads.ts` asks the mirror node for that list.
///      `hardhat_setCode` copies runtime code only, so the state starts empty and a test fills it with `mockMint`.
contract MockLpNft {
    mapping(uint256 serial => address) private owners;
    mapping(address owner => mapping(address operator => bool)) private operatorApproval;

    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function ownerOf(uint256 serial) external view returns (address) {
        address owner = owners[serial];
        require(owner != address(0), "Invalid token ID");
        return owner;
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return operatorApproval[owner][operator];
    }

    function setApprovalForAll(address operator, bool approved) external {
        operatorApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function mockMint(address to, uint256 serial) external {
        require(owners[serial] == address(0), "MockLpNft: serial already minted");
        owners[serial] = to;
    }

    function mockBurn(uint256 serial) external {
        owners[serial] = address(0);
    }
}
