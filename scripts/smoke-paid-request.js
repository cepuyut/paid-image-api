#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Smoke test: real paid MPP transaction against PixelPay
//
// Usage:
//   node --env-file=.env scripts/smoke-paid-request.js
//   node --env-file=.env scripts/smoke-paid-request.js --model fal-ai/flux/dev
//   node --env-file=.env scripts/smoke-paid-request.js --local
//
// Flags:
//   --model <id>   fal.ai model (default: fal-ai/flux/schnell — cheapest at $0.029)
//   --prompt <s>   override prompt
//   --local        hit http://localhost:3000 instead of production
//   --skip-balance skip pre-flight USDC balance check
// ---------------------------------------------------------------------------

import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { Mppx, tempo } from "mppx/client";

// --- CLI parsing -----------------------------------------------------------
const args = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const hasFlag = (name) => args.includes(`--${name}`);

const MODEL = getFlag("model", "fal-ai/flux/schnell");
const PROMPT = getFlag(
  "prompt",
  "PixelPay logo — glowing letter P made of pixels dissolving into golden coins, black background, minimalist",
);
const BASE = hasFlag("local") ? "http://localhost:3000" : "https://pixelpayapi.com";
const SKIP_BAL = hasFlag("skip-balance");

// --- Tempo chain config ----------------------------------------------------
const TEMPO_RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.zone";
const USDC = process.env.CURRENCY_TOKEN || "0x20c000000000000000000000b9537d11c60e8b50";
const TEMPO_CHAIN = {
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "TEMPO", symbol: "TEMPO", decimals: 18 },
  rpcUrls: { default: { http: [TEMPO_RPC] } },
};

// --- Wallet setup ----------------------------------------------------------
if (!process.env.WALLET_PRIVATE_KEY) {
  console.error("❌ WALLET_PRIVATE_KEY missing in .env");
  process.exit(1);
}
const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
Mppx.create({ methods: [tempo({ account })] });

console.log(`\n🧪 PixelPay smoke test`);
console.log(`   Target:  ${BASE}`);
console.log(`   Wallet:  ${account.address}`);
console.log(`   Model:   ${MODEL}`);

// --- Pre-flight USDC balance ----------------------------------------------
if (!SKIP_BAL) {
  try {
    const client = createPublicClient({ chain: TEMPO_CHAIN, transport: http(TEMPO_RPC) });
    const bal = await client.readContract({
      address: USDC,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [account.address],
    });
    const human = Number(formatUnits(bal, 6));
    console.log(`   USDC:    ${human.toFixed(6)} on Tempo`);
    if (human < 0.05) {
      console.error(`\n❌ Insufficient USDC. Need ≥ $0.05 to cover challenge (cheapest model is $0.029).`);
      console.error(`   Fund ${account.address} with Tempo-USDC first.`);
      process.exit(1);
    }
  } catch (e) {
    console.warn(`   USDC:    (balance check failed: ${e.message})`);
  }
}

// --- Fire paid request -----------------------------------------------------
console.log(`\n⏳ POST ${BASE}/v1/images/generate`);
const t0 = Date.now();
const res = await fetch(`${BASE}/v1/images/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: PROMPT,
    model: MODEL,
    image_size: "square_hd",
    wallet: account.address,
  }),
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n📡 Response  ${res.status} in ${elapsed}s`);

const receipt = res.headers.get("Payment-Receipt") || res.headers.get("payment-receipt");
const txHash = res.headers.get("X-Payment-Tx") || res.headers.get("x-payment-tx");
if (receipt) console.log(`   Receipt:  ${receipt}`);
if (txHash) {
  console.log(`   Tx hash:  ${txHash}`);
  console.log(`   MPPscan:  https://www.mppscan.com/tx/${txHash}`);
}

if (!res.ok) {
  const err = await res.text();
  console.error(`\n❌ Request failed:\n${err}`);
  process.exit(1);
}

const data = await res.json();
console.log(`\n✅ Success`);
console.log(`   Model:   ${data.model}`);
console.log(`   Images:  ${data.images?.length || 0}`);
data.images?.forEach((img, i) => console.log(`     ${i + 1}. ${img.url}`));
if (data.pxp_reward) console.log(`   PXP:     +${data.pxp_reward}`);

console.log(`\n🔍 Verify on MPPscan:`);
console.log(`   https://www.mppscan.com/address/${account.address}`);
console.log(`   https://www.mppscan.com/server/87d8f501693c40a7e4102a17c32ef9e21b51f41b137fd2af26fa4a74e079deb0`);
console.log(`\nDone. Give indexer ~60s to pick up the tx.\n`);
