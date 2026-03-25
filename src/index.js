import express from "express";
import { createChallenge, verifyCredential, createReceipt } from "./mpp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Tiered pricing per model (base units, 6 decimals: 1 pathUSD = 1_000_000)
// ---------------------------------------------------------------------------
const PRICING_TIERS = {
  // fal.ai models
  "fal-ai/flux/schnell":       { price: "30000",  usd: "0.03", tier: "schnell" },
  "fal-ai/flux/dev":           { price: "50000",  usd: "0.05", tier: "dev" },
  "fal-ai/flux-pro/v1.1":     { price: "100000", usd: "0.10", tier: "pro" },
  // Bluesminds models
  "gemini-3-pro-image-preview":{ price: "50000",  usd: "0.05", tier: "dev" },
};
const DEFAULT_PRICE = { price: "50000", usd: "0.05", tier: "dev" };

function getPricing(model) {
  return PRICING_TIERS[model] || DEFAULT_PRICE;
}

// Image backend: "bluesminds" (default) or "fal"
const IMAGE_BACKEND = process.env.IMAGE_BACKEND || "bluesminds";
const BLUESMINDS_KEY = process.env.BLUESMINDS_KEY;
const BLUESMINDS_BASE = process.env.BLUESMINDS_BASE || "https://api.bluesminds.com/v1";

// fal.ai (optional)
let fal;
if (IMAGE_BACKEND === "fal") {
  const falClient = await import("@fal-ai/client");
  fal = falClient.fal;
  fal.config({ credentials: process.env.FAL_KEY });
}

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// MPP Discovery: GET /openapi.json
// ---------------------------------------------------------------------------

app.get("/openapi.json", (_req, res) => {
  const doc = JSON.parse(readFileSync(join(ROOT, "openapi.json"), "utf8"));
  res.set("Cache-Control", "max-age=300");
  res.json(doc);
});

// ---------------------------------------------------------------------------
// LLM-friendly docs: GET /llms.txt
// ---------------------------------------------------------------------------

app.get("/llms.txt", (_req, res) => {
  const txt = readFileSync(join(ROOT, "llms.txt"), "utf8");
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "max-age=300");
  res.send(txt);
});

// ---------------------------------------------------------------------------
// Paid endpoint: POST /v1/images/generate
// ---------------------------------------------------------------------------

app.post("/v1/images/generate", async (req, res) => {
  const authHeader = req.get("Authorization");
  const { prompt, model, image_size, num_images } = req.body || {};

  // Determine price from requested model
  const pricing = getPricing(model);

  // --- No credential → 402 challenge ---
  if (!authHeader || !authHeader.startsWith("Payment ")) {
    const { statusCode, headers, body } = createChallenge({
      amount: pricing.price,
      description: `Generate an image for ${pricing.usd} pathUSD (${pricing.tier} tier)`,
    });
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    return res.status(statusCode).json(body);
  }

  // --- Verify credential ---
  const { ok, error, credential } = await verifyCredential(authHeader, pricing.price);
  if (!ok) {
    const { statusCode, headers, body } = createChallenge({
      amount: pricing.price,
      description: `Generate an image for ${pricing.usd} pathUSD (${pricing.tier} tier)`,
    });
    body.type = `https://paymentauth.org/problems/${error}`;
    body.title = error.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    body.detail = `Payment verification failed: ${error}`;
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    return res.status(402).json(body);
  }

  // --- Validate request body ---
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({
      type: "https://paymentauth.org/problems/bad-request",
      title: "Bad Request",
      status: 400,
      detail: "A 'prompt' string is required.",
    });
  }

  // --- Call image backend ---
  try {
    let images, usedModel, timings;

    if (IMAGE_BACKEND === "fal") {
      const falModel = model || "fal-ai/flux/schnell";
      const result = await fal.subscribe(falModel, {
        input: {
          prompt,
          image_size: image_size || "landscape_4_3",
          num_images: Math.min(num_images || 1, 4),
        },
      });
      images = result.data?.images || [];
      usedModel = falModel;
      timings = result.data?.timings;
    } else {
      // Bluesminds (OpenAI-compatible /v1/images/generations)
      usedModel = model || "gemini-3-pro-image-preview";
      const resp = await fetch(`${BLUESMINDS_BASE}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BLUESMINDS_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: usedModel,
          prompt,
          n: Math.min(num_images || 1, 4),
          size: image_size || "1024x1024",
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Bluesminds ${resp.status}: ${errBody}`);
      }
      const data = await resp.json();
      images = (data.data || []).map((d) => ({
        url: d.url || undefined,
        content_type: "image/png",
        ...(d.b64_json ? { b64_json: d.b64_json } : {}),
      }));
    }

    const receipt = createReceipt(credential?.payload?.hash || credential?.payload?.signature?.slice(0, 20));

    res.set("Payment-Receipt", receipt);
    res.set("Cache-Control", "private");
    res.json({ images, prompt, model: usedModel, timings });
  } catch (err) {
    console.error("Image backend error:", err.message);
    res.status(502).json({
      type: "https://paymentauth.org/problems/upstream-error",
      title: "Upstream Error",
      status: 502,
      detail: "Image generation failed. Please retry.",
    });
  }
});

// ---------------------------------------------------------------------------
// Pricing endpoint: GET /v1/prices
// ---------------------------------------------------------------------------

app.get("/v1/prices", (_req, res) => {
  const tiers = Object.entries(PRICING_TIERS).map(([model, info]) => ({
    model,
    tier: info.tier,
    price_base_units: info.price,
    price_usd: info.usd,
  }));
  res.set("Cache-Control", "max-age=300");
  res.json({ currency: "pathUSD", decimals: 6, tiers });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`paid-image-api listening on ${HOST}`);
  console.log(`  POST ${HOST}/v1/images/generate  (MPP-protected, tiered pricing)`);
  console.log(`  GET  ${HOST}/v1/prices`);
  console.log(`  GET  ${HOST}/openapi.json`);
  console.log(`  GET  ${HOST}/llms.txt`);
});
