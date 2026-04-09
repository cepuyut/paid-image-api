/**
 * Test + save image to file.
 * Usage: node test-save.js "prompt" [model]
 */

import { writeFileSync } from "node:fs";

const BASE = process.env.API_URL || "https://pixelpayapi.com";
const prompt = process.argv[2] || "a cat wearing sunglasses on a beach";
const model = process.argv[3] || "fal-ai/flux/schnell";

function b64url(str) { return Buffer.from(str).toString("base64url"); }
function parseWwwAuth(header) {
  const params = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  return params;
}

async function main() {
  console.log(`Prompt: "${prompt}" | Model: ${model}\n`);

  // Step 1: Get challenge
  const r1 = await fetch(`${BASE}/v1/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });
  const ch = parseWwwAuth(r1.headers.get("WWW-Authenticate"));
  console.log(`Challenge: ${(await r1.json()).detail}`);

  // Step 2: Pay + get image
  const cred = b64url(JSON.stringify({
    challenge: { id: ch.id, realm: ch.realm, method: ch.method, intent: ch.intent, request: ch.request, expires: ch.expires },
    payload: { hash: "0x" + "ab".repeat(32), signature: "0x" + "cd".repeat(65) },
  }));

  const r2 = await fetch(`${BASE}/v1/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Payment ${cred}` },
    body: JSON.stringify({ prompt, model }),
  });

  if (!r2.ok) { console.log("FAILED:", (await r2.json()).detail); return; }

  const data = await r2.json();
  data.images?.forEach((img, i) => {
    if (img.b64_json) {
      const filename = `output-${i + 1}.png`;
      writeFileSync(filename, Buffer.from(img.b64_json, "base64"));
      console.log(`Saved: ${filename}`);
    } else if (img.url) {
      console.log(`URL: ${img.url}`);
    }
  });
  console.log("Done!");
}

main().catch(console.error);
