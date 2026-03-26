/**
 * Manual Payment Flow — 2 steps
 *
 * Step 1: Get challenge & payment details
 *   node examples/manual-pay.js "your prompt"
 *
 * Step 2: After sending USDC via Tempo dashboard, paste tx hash
 *   node examples/manual-pay.js "your prompt" TX_HASH
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const API_URL = process.env.API_URL || "https://paid-image-api.onrender.com";
const prompt = process.argv[2] || "a cute cat";
const model = process.argv[3] || "fal-ai/flux/schnell";
const txHash = process.argv[4];

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

async function main() {
  // ── Step 1: Get 402 challenge ──
  console.log("\n🔹 Step 1: Getting payment challenge...\n");

  const res1 = await fetch(`${API_URL}/v1/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });

  if (res1.status !== 402) {
    console.log(`Unexpected status: ${res1.status}`);
    console.log(await res1.text());
    return;
  }

  const wwwAuth = res1.headers.get("WWW-Authenticate");
  const ch = parseWwwAuth(wwwAuth);
  const requestObj = JSON.parse(b64urlDecode(ch.request));

  const amountUSD = (Number(requestObj.amount) / 1_000_000).toFixed(2);

  console.log(`  Prompt:     "${prompt}"`);
  console.log(`  Model:      ${model}`);
  console.log(`  Amount:     ${amountUSD} USDC (${requestObj.amount} base units)`);
  console.log(`  Send to:    ${requestObj.recipient}`);
  console.log(`  Token:      USDC.e (${requestObj.currency})`);
  console.log(`  Expires:    ${ch.expires}\n`);

  // Save challenge for step 2
  writeFileSync("/tmp/mpp-challenge.json", JSON.stringify(ch));

  if (!txHash) {
    console.log("═══════════════════════════════════════════════");
    console.log("  Now send USDC from your Tempo dashboard:");
    console.log(`  → Amount: ${amountUSD} USDC`);
    console.log(`  → To: ${requestObj.recipient}`);
    console.log("");
    console.log("  Then re-run with the tx hash:");
    console.log(`  node examples/manual-pay.js "${prompt}" ${model} TX_HASH`);
    console.log("═══════════════════════════════════════════════\n");
    return;
  }

  // ── Step 2: Build credential & get image ──
  console.log(`🔹 Step 2: Using tx hash: ${txHash}\n`);

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
      hash: txHash,
    },
  };

  const credentialB64 = b64url(JSON.stringify(credential));

  console.log("🔹 Step 3: Requesting image with payment proof...\n");

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
  console.log(`  ✓ Image generated!`);
  console.log(`  Model: ${data.model}`);

  data.images?.forEach((img, i) => {
    if (img.url) console.log(`\n  🖼️  Image URL: ${img.url}`);
    if (img.b64_json) {
      const filename = `output-${i + 1}.jpg`;
      writeFileSync(filename, Buffer.from(img.b64_json, "base64"));
      console.log(`\n  🖼️  Saved: ${filename}`);
    }
  });

  console.log("\n✅ Done! Payment verified, image delivered.\n");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
