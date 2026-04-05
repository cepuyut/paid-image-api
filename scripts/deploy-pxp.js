// Deploy PXP Token to Tempo
// Usage: node --env-file=.env scripts/deploy-pxp.js

import { createWalletClient, createPublicClient, http, defineChain, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const PATHUSD = "0x20C0000000000000000000000000000000000000";

const tempo = defineChain({
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "pathUSD", symbol: "pUSD", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.tempo.xyz"] } },
});

const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
console.log("Deploying PXP Token with:", account.address);

const publicClient = createPublicClient({ chain: tempo, transport: http() });
const walletClient = createWalletClient({ chain: tempo, transport: http(), account });

const artifact = JSON.parse(readFileSync("artifacts/contracts/PXPToken.sol/PXPToken.json", "utf8"));

const deployData = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [],
});

console.log("\nDeploying PXP Token...");
const hash = await walletClient.sendTransaction({
  data: deployData,
  feeToken: PATHUSD,
});

console.log("Tx hash:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });

console.log("\n========================================");
console.log("PXP TOKEN DEPLOYED");
console.log("========================================");
console.log("Contract:  ", receipt.contractAddress);
console.log("Owner:     ", account.address);
console.log("Max Supply: 21,000,000 PXP");
console.log("Initial:    3,150,000 PXP (15% to deployer)");
console.log("\nAdd to your .env:");
console.log(`PXP_TOKEN_ADDRESS=${receipt.contractAddress}`);
console.log("========================================");
