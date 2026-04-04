// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @title PixelPayNFT — Mint AI-generated images as NFTs on Tempo
/// @notice Anyone can mint. Creator gets 5% royalty on secondary sales (ERC-2981).
contract PixelPayNFT is ERC721, ERC721URIStorage, ERC2981 {
    uint256 private _nextTokenId;
    uint96 public constant ROYALTY_BPS = 500; // 5%

    event Minted(uint256 indexed tokenId, address indexed creator, string tokenURI);

    constructor() ERC721("PixelPay", "PXPAY") {}

    /// @notice Mint a new NFT with metadata URI (IPFS)
    /// @param to The address that will own the NFT
    /// @param uri The metadata URI (ipfs://... or https://...)
    /// @return tokenId The newly minted token ID
    function mint(address to, string calldata uri) external returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        // Set royalty: creator receives 5% on secondary sales
        _setTokenRoyalty(tokenId, to, ROYALTY_BPS);
        emit Minted(tokenId, to, uri);
        return tokenId;
    }

    /// @notice Total number of minted NFTs
    function totalSupply() external view returns (uint256) {
        return _nextTokenId;
    }

    // --- Overrides ---

    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage) returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage, ERC2981) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
