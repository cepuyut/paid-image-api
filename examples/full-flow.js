/**
 * Full MPP Payment Flow — End-to-end tutorial
 *
 * This script demonstrates the complete flow:
 * 1. POST prompt → get 402 challenge
 * 2. Parse challenge → extract payment details
 * 3. Sign & submit USDC transfer on Tempo blockchain
 * 4. Build credential with tx hash
 * 5. Retry request → get image
 *
 * Usage:
 *   npm install ethers
 *   PRIVATE_KEY=0x... node examples/full-flow.js "a cat in space"
 *
 * Requirements:
 *   - A Tempo wallet with USDC balance
 *   - Private key for that wallet (PRIVATE_KEY env var)
 */

import { ethers } from "ethers";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.API_URL || "https://pixelpayapi.com";
const TEMPO_RPC = "https://rpc.tempo.xyz";
const CHAIN_ID = 4217; // Tempo mainnet chain ID
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("ERROR: Set PRIVATE_KEY environment variable");
  console.error("Example: PRIVATE_KEY=0xabc123... node examples/full-flow.js \"your prompt\"");
  process.exit(1);
}

const prompt = process.argv[2] || "a cute cat wearing sunglasses on a beach";
const model = process.argv[3] || "fal-ai/flux/schnell";

// ERC-20 Transfer ABI (minimal)
const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64url(str) {
  return Buffer.from(str).toString("base64url");
}

function b64urlDecode(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}

function parseWwwAuth(header) {
  const params = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  return params;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  PixelPay — Full MPP Payment Flow");
  console.log("═══════════════════════════════════════════════\n");

  // ── Step 1: POST prompt, get 402 challenge ──
  console.log("Step 1: Requesting image...");
  console.log(`  Prompt: "${prompt}"`);
  console.log(`  Model:  ${model}\n`);

  const res1 = await fetch(`${API_URL}/v1/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });

  if (res1.status !== 402) {
    console.error(`  Unexpected status: ${res1.status}`);
    console.error(await res1.text());
    return;
  }

  const wwwAuth = res1.headers.get("WWW-Authenticate");
  const challengeBody = await res1.json();
  console.log(`  ✓ Got 402: "${challengeBody.detail}"`);

  // ── Step 2: Parse challenge ──
  console.log("\nStep 2: Parsing payment challenge...");
  const ch = parseWwwAuth(wwwAuth);
  const requestObj = JSON.parse(b64urlDecode(ch.request));

  console.log(`  Recipient:  ${requestObj.recipient}`);
  console.log(`  Amount:     ${requestObj.amount} base units`);
  console.log(`  Currency:   ${requestObj.currency}`);
  console.log(`  Chain ID:   ${requestObj.methodDetails.chainId}`);
  console.log(`  Expires:    ${ch.expires}`);
  console.log(`  Fee payer:  ${requestObj.methodDetails.feePayer ? "server pays gas" : "you pay gas"}`);

  // ── Step 3: Sign & submit USDC transfer on Tempo ──
  console.log("\nStep 3: Submitting payment on Tempo blockchain...");

  const provider = new ethers.JsonRpcProvider(TEMPO_RPC, CHAIN_ID, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`  Your wallet: ${wallet.address}`);

  // Check USDC balance first
  const USDC = new ethers.Contract(requestObj.currency, ERC20_ABI, wallet);

  const tx = await USDC.transfer(
    requestObj.recipient,
    BigInt(requestObj.amount)
  );

  console.log(`  ✓ Transaction sent: ${tx.hash}`);
  console.log("  Waiting for confirmation...");

  const receipt = await tx.wait();
  console.log(`  ✓ Confirmed in block ${receipt.blockNumber}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}`);

  // ── Step 4: Build credential with tx hash ──
  console.log("\nStep 4: Building payment credential...");

  const credential = {
    challenge: {
      id: ch.id,
      realm: ch.realm,
      method: ch.method,
      intent: ch.intent,
      request: ch.request,
      expires: ch.expires,
    },
    payload: {
      hash: tx.hash,
    },
  };

  const credentialB64 = b64url(JSON.stringify(credential));
  console.log(`  ✓ Credential built (${credentialB64.length} chars)`);

  // ── Step 5: Retry with credential, get image ──
  console.log("\nStep 5: Requesting image with payment proof...");

  const res2 = await fetch(`${API_URL}/v1/images/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Payment ${credentialB64}`,
    },
    body: JSON.stringify({ prompt, model }),
  });

  console.log(`  Status: ${res2.status}`);

  if (!res2.ok) {
    const err = await res2.json();
    console.error(`  ✗ Failed: ${err.detail}`);
    return;
  }

  const data = await res2.json();
  const paymentReceipt = res2.headers.get("Payment-Receipt");

  console.log(`  ✓ Image generated!`);
  console.log(`  Model: ${data.model}`);
  console.log(`  Images: ${data.images?.length || 0}`);
  if (paymentReceipt) {
    console.log(`  Receipt: ${paymentReceipt.slice(0, 50)}...`);
  }

  // Save image
  data.images?.forEach((img, i) => {
    if (img.url) {
      console.log(`\n  Image ${i + 1} URL: ${img.url}`);
    }
    if (img.b64_json) {
      const filename = `output-${i + 1}.jpg`;
      writeFileSync(filename, Buffer.from(img.b64_json, "base64"));
      console.log(`\n  Image ${i + 1} saved: ${filename}`);
    }
  });

  console.log("\n═══════════════════════════════════════════════");
  console.log("  Done! Payment verified on-chain.");
  console.log("═══════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
