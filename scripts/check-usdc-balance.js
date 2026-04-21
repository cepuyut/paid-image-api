#!/usr/bin/env node
// Quick USDC balance check on Tempo
import { createPublicClient, http, formatUnits } from "viem";

const TEMPO_RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.zone";
const USDC = process.env.CURRENCY_TOKEN || "0x20c000000000000000000000b9537d11c60e8b50";
const WALLET = process.env.WALLET_ADDRESS || "0xf48c6E46358652fC77462d56d609B8bC7f4ba82e";

const TEMPO_CHAIN = {
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "TEMPO", symbol: "TEMPO", decimals: 18 },
  rpcUrls: { default: { http: [TEMPO_RPC] } },
};

const client = createPublicClient({ chain: TEMPO_CHAIN, transport: http(TEMPO_RPC) });

try {
  const bal = await client.readContract({
    address: USDC,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [WALLET],
  });
  console.log(`Wallet:  ${WALLET}`);
  console.log(`USDC:    ${formatUnits(bal, 6)}`);

  const blockNum = await client.getBlockNumber();
  console.log(`Block:   ${blockNum}`);
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}
