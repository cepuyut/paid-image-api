#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Test real MPP transaction against PixelPay
// Usage: node --env-file=.env scripts/test-transaction.js
// ---------------------------------------------------------------------------

import { privateKeyToAccount } from "viem/accounts";
import { Mppx, tempo } from "mppx/client";

// Initialize mppx with wallet (auto-pays 402 challenges)
const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
Mppx.create({ methods: [tempo({ account })] });
console.log(`Wallet: ${account.address}`);

const BASE = "https://pixelpayapi.com";

// Generate 1 image with cheapest model (schnell = $0.029)
console.log("\nGenerating image with fal-ai/flux/schnell ($0.029)...");
const res = await fetch(`${BASE}/v1/images/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "PixelPay logo — a glowing letter P made of pixels dissolving into golden coins, black background, minimalist",
    model: "fal-ai/flux/schnell",
    image_size: "square_hd",
    wallet: account.address,
  }),
});

console.log(`Status: ${res.status}`);
const receipt = res.headers.get("Payment-Receipt");
if (receipt) console.log(`Payment-Receipt: ${receipt}`);

if (res.ok) {
  const data = await res.json();
  console.log(`Model: ${data.model}`);
  console.log(`Images: ${data.images?.length}`);
  data.images?.forEach((img, i) => console.log(`  ${i + 1}. ${img.url}`));
  if (data.pxp_reward) console.log(`PXP reward: ${data.pxp_reward}`);
  console.log("\nTransaction complete! Check MPPscan for activity.");
} else {
  const err = await res.text();
  console.error("Error:", err);
}
