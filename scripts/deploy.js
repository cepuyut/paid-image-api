// Deploy PixelPayNFT and PixelPayMarket to Tempo
// Usage: node node_modules/hardhat/dist/src/cli.js run scripts/deploy.js --network tempo
//
// Requires WALLET_PRIVATE_KEY in .env

import hre from "hardhat";

const [deployer] = await hre.ethers.getSigners();
console.log("Deploying with:", deployer.address);

const balance = await hre.ethers.provider.getBalance(deployer.address);
console.log("Balance:", hre.ethers.formatEther(balance), "TEMPO\n");

// 1. Deploy PixelPayNFT
console.log("--- Deploying PixelPayNFT ---");
const NFT = await hre.ethers.getContractFactory("PixelPayNFT");
const nft = await NFT.deploy();
await nft.waitForDeployment();
const nftAddr = await nft.getAddress();
console.log("PixelPayNFT deployed to:", nftAddr);

// 2. Deploy PixelPayMarket
const USDC = "0x20c000000000000000000000b9537d11c60e8b50";
const feeRecipient = deployer.address;

console.log("\n--- Deploying PixelPayMarket ---");
const Market = await hre.ethers.getContractFactory("PixelPayMarket");
const market = await Market.deploy(nftAddr, USDC, feeRecipient);
await market.waitForDeployment();
const marketAddr = await market.getAddress();
console.log("PixelPayMarket deployed to:", marketAddr);

// Summary
console.log("\n========================================");
console.log("DEPLOYMENT COMPLETE");
console.log("========================================");
console.log("PixelPayNFT:    ", nftAddr);
console.log("PixelPayMarket: ", marketAddr);
console.log("Fee Recipient:  ", deployer.address);
console.log("USDC Token:     ", USDC);
console.log("\nAdd to your .env:");
console.log(`NFT_CONTRACT_ADDRESS=${nftAddr}`);
console.log(`MARKETPLACE_CONTRACT_ADDRESS=${marketAddr}`);
console.log("========================================");
