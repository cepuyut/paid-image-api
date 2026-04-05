// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PXP Token — PixelPay Utility Token
 * @dev ERC-20 with owner-controlled minting up to a hard cap of 21,000,000 PXP.
 *      Used as a reward/utility token within the PixelPay ecosystem.
 */
contract PXPToken {
    string public constant name = "PixelPay Token";
    string public constant symbol = "PXP";
    uint8  public constant decimals = 18;
    uint256 public constant MAX_SUPPLY = 21_000_000 * 1e18; // 21M hard cap

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;

        // Mint initial allocations:
        // Treasury (10%) = 2,100,000 PXP — to deployer for operations
        // Creator  (5%)  = 1,050,000 PXP — founder allocation
        // Total initial  = 3,150,000 PXP (15%)
        // Remaining 85% minted over time as rewards
        uint256 initial = 3_150_000 * 1e18;
        balanceOf[msg.sender] = initial;
        totalSupply = initial;
        emit Transfer(address(0), msg.sender, initial);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "Insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "Insufficient balance");
        require(allowance[from][msg.sender] >= value, "Insufficient allowance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }

    /**
     * @dev Mint new PXP tokens (only owner). Used to distribute rewards.
     *      Cannot exceed MAX_SUPPLY.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply + amount <= MAX_SUPPLY, "Exceeds max supply");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /**
     * @dev Transfer ownership to a new address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
