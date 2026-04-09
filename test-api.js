/**
 * Test script for the PixelPay MPP flow.
 * Usage: node test-api.js "your prompt here" [model]
 */

const BASE = process.env.API_URL || "https://pixelpayapi.com";

const prompt = process.argv[2] || "a cat wearing sunglasses on a beach";
const model = process.argv[3] || "fal-ai/flux/schnell";

function b64url(str) {
  return Buffer.from(str).toString("base64url");
}

function parseWwwAuth(header) {
  const params = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  return params;
}

async function main() {
  console.log(`\n--- PixelPay Test ---`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`Model:  ${model}`);
  console.log(`Server: ${BASE}\n`);

  // Step 1: Get 402 challenge
  console.log("1. Requesting challenge...");
  const res1 = await fetch(`${BASE}/v1/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });

  const challenge402 = await res1.json();
  const wwwAuth = res1.headers.get("WWW-Authenticate");
  console.log(`   402: ${challenge402.detail}`);

  // Step 2: Parse challenge
  const ch = parseWwwAuth(wwwAuth);
  console.log(`   Challenge ID: ${ch.id}`);
  console.log(`   Expires: ${ch.expires}`);

  // Step 3: Build credential (echoes challenge + simulated tx hash)
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
      hash: "0x" + "ab".repeat(32), // simulated tx hash
      signature: "0x" + "cd".repeat(65),
    },
  };

  const credentialB64 = b64url(JSON.stringify(credential));
  console.log("\n2. Sending payment credential...");

  // Step 4: Retry with credential
  const res2 = await fetch(`${BASE}/v1/images/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Payment ${credentialB64}`,
    },
    body: JSON.stringify({ prompt, model }),
  });

  console.log(`   Status: ${res2.status}`);

  if (res2.ok) {
    const data = await res2.json();
    const receipt = res2.headers.get("Payment-Receipt");
    console.log(`   Receipt: ${receipt?.slice(0, 40)}...`);
    console.log(`   Model used: ${data.model}`);
    console.log(`   Images generated: ${data.images?.length || 0}`);
    data.images?.forEach((img, i) => {
      console.log(`\n   Image ${i + 1}:`);
      if (img.url) console.log(`   URL: ${img.url}`);
      if (img.b64_json) console.log(`   Base64: (${img.b64_json.length} chars)`);
    });
    console.log("\n--- SUCCESS ---\n");
  } else {
    const err = await res2.json();
    console.log(`   Error: ${err.detail}`);
    console.log("\n--- FAILED ---\n");
  }
}

main().catch(console.error);
