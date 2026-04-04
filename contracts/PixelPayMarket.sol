// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PixelPayMarket — NFT Marketplace for PixelPay on Tempo
/// @notice List and buy NFTs with USDC. 2.5% platform fee.
contract PixelPayMarket is ReentrancyGuard {
    IERC721 public immutable nft;
    IERC20 public immutable usdc;
    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 250; // 2.5%

    struct Listing {
        address seller;
        uint128 price; // USDC amount (6 decimals)
        uint64 listedAt;
    }

    mapping(uint256 => Listing) public listings;
    uint256[] public activeTokenIds;
    mapping(uint256 => uint256) private _tokenIdIndex; // tokenId → index in activeTokenIds

    event Listed(uint256 indexed tokenId, address indexed seller, uint128 price);
    event Sold(uint256 indexed tokenId, address indexed buyer, address indexed seller, uint128 price);
    event Cancelled(uint256 indexed tokenId, address indexed seller);

    constructor(address _nft, address _usdc, address _feeRecipient) {
        nft = IERC721(_nft);
        usdc = IERC20(_usdc);
        feeRecipient = _feeRecipient;
    }

    /// @notice List an NFT for sale. Caller must have approved this contract.
    function list(uint256 tokenId, uint128 price) external {
        require(price > 0, "Price must be > 0");
        require(nft.ownerOf(tokenId) == msg.sender, "Not owner");
        require(nft.getApproved(tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)), "Not approved");

        listings[tokenId] = Listing({
            seller: msg.sender,
            price: price,
            listedAt: uint64(block.timestamp)
        });

        _tokenIdIndex[tokenId] = activeTokenIds.length;
        activeTokenIds.push(tokenId);

        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Buy a listed NFT. Caller must have approved USDC spending.
    function buy(uint256 tokenId) external nonReentrant {
        Listing memory item = listings[tokenId];
        require(item.seller != address(0), "Not listed");
        require(msg.sender != item.seller, "Cannot buy own NFT");

        uint256 fee = (uint256(item.price) * FEE_BPS) / 10000;
        uint256 sellerAmount = uint256(item.price) - fee;

        // Transfer USDC: buyer → seller + fee
        require(usdc.transferFrom(msg.sender, item.seller, sellerAmount), "USDC transfer to seller failed");
        if (fee > 0) {
            require(usdc.transferFrom(msg.sender, feeRecipient, fee), "USDC fee transfer failed");
        }

        // Transfer NFT: seller → buyer
        nft.transferFrom(item.seller, msg.sender, tokenId);

        // Remove listing
        _removeListing(tokenId);

        emit Sold(tokenId, msg.sender, item.seller, item.price);
    }

    /// @notice Cancel a listing
    function cancel(uint256 tokenId) external {
        require(listings[tokenId].seller == msg.sender, "Not seller");
        _removeListing(tokenId);
        emit Cancelled(tokenId, msg.sender);
    }

    /// @notice Get all active token IDs
    function getActiveListings() external view returns (uint256[] memory) {
        return activeTokenIds;
    }

    /// @notice Number of active listings
    function activeCount() external view returns (uint256) {
        return activeTokenIds.length;
    }

    function _removeListing(uint256 tokenId) private {
        uint256 idx = _tokenIdIndex[tokenId];
        uint256 last = activeTokenIds.length - 1;
        if (idx != last) {
            uint256 lastTokenId = activeTokenIds[last];
            activeTokenIds[idx] = lastTokenId;
            _tokenIdIndex[lastTokenId] = idx;
        }
        activeTokenIds.pop();
        delete _tokenIdIndex[tokenId];
        delete listings[tokenId];
    }
}
