// Deploy PixelPayNFT and PixelPayMarket to Tempo using viem
// Usage: node --env-file=.env scripts/deploy.js
//
// Requires WALLET_PRIVATE_KEY in .env
// Tempo has no native gas token — fees are paid in pathUSD (feeToken)

import { createWalletClient, createPublicClient, http, defineChain, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const PATHUSD = "0x20C0000000000000000000000000000000000000";
const USDC = "0x20c000000000000000000000b9537d11c60e8b50";

const tempo = defineChain({
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "pathUSD", symbol: "pUSD", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.tempo.xyz"] } },
  blockExplorers: { default: { name: "Tempo Explorer", url: "https://explorer.tempo.xyz" } },
});

const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
console.log("Deploying with:", account.address);

const publicClient = createPublicClient({ chain: tempo, transport: http() });
const walletClient = createWalletClient({ chain: tempo, transport: http(), account });

// Load compiled artifacts
const nftArtifact = JSON.parse(readFileSync("artifacts/contracts/PixelPayNFT.sol/PixelPayNFT.json", "utf8"));
const marketArtifact = JSON.parse(readFileSync("artifacts/contracts/PixelPayMarket.sol/PixelPayMarket.json", "utf8"));

async function deploy(name, artifact, args = []) {
  console.log(`\n--- Deploying ${name} ---`);

  const deployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });

  const hash = await walletClient.sendTransaction({
    data: deployData,
    feeToken: PATHUSD,
  });

  console.log("Tx hash:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${name} deployed to:`, receipt.contractAddress);
  return receipt.contractAddress;
}

// 1. Deploy PixelPayNFT
const nftAddr = await deploy("PixelPayNFT", nftArtifact);

// 2. Deploy PixelPayMarket(nftAddr, USDC, feeRecipient)
const marketAddr = await deploy("PixelPayMarket", marketArtifact, [nftAddr, USDC, account.address]);

// Summary
console.log("\n========================================");
console.log("DEPLOYMENT COMPLETE");
console.log("========================================");
console.log("PixelPayNFT:    ", nftAddr);
console.log("PixelPayMarket: ", marketAddr);
console.log("Fee Recipient:  ", account.address);
console.log("USDC Token:     ", USDC);
console.log("\nAdd to your .env:");
console.log(`NFT_CONTRACT_ADDRESS=${nftAddr}`);
console.log(`MARKETPLACE_CONTRACT_ADDRESS=${marketAddr}`);
console.log("========================================");
