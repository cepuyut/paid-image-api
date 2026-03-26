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

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Tiered pricing per model (base units, 6 decimals: 1 USDC = 1_000_000)
// ---------------------------------------------------------------------------
const BASE_PRICING = {
  // Flux family
  "fal-ai/flux/schnell":        { base: 30000,  tier: "schnell" },
  "fal-ai/flux/dev":            { base: 50000,  tier: "dev" },
  "fal-ai/flux-pro/v1.1":       { base: 100000, tier: "pro" },
  // Recraft V3 (SVG + raster)
  "fal-ai/recraft-v3":          { base: 60000,  tier: "recraft" },
  // Stable Diffusion 3.5
  "fal-ai/stable-diffusion-v35-large": { base: 40000, tier: "sd35" },
  // HiDream (high quality)
  "fal-ai/hidream-i1-full":     { base: 80000,  tier: "hidream" },
  // Ideogram V3 (text-in-image)
  "fal-ai/ideogram/v3":         { base: 80000,  tier: "ideogram" },
};
const DEFAULT_MODEL = "fal-ai/flux/schnell";

// ---------------------------------------------------------------------------
// Dynamic pricing — adjusts based on request volume (last 5 min window)
// ---------------------------------------------------------------------------
const REQUEST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const requestTimestamps = [];

function getDemandMultiplier() {
  const now = Date.now();
  // Clean old timestamps
  while (requestTimestamps.length && requestTimestamps[0] < now - REQUEST_WINDOW_MS) {
    requestTimestamps.shift();
  }
  const rpm = requestTimestamps.length;
  // Surge tiers: 0-10 req → 1x, 10-30 → 1.25x, 30-60 → 1.5x, 60+ → 2x
  if (rpm >= 60) return 2.0;
  if (rpm >= 30) return 1.5;
  if (rpm >= 10) return 1.25;
  return 1.0;
}

function getPricing(model) {
  const info = BASE_PRICING[model] || BASE_PRICING[DEFAULT_MODEL];
  const multiplier = getDemandMultiplier();
  const price = Math.round(info.base * multiplier);
  const usd = (price / 1_000_000).toFixed(2);
  return { price: String(price), usd, tier: info.tier, multiplier };
}

function trackRequest() {
  requestTimestamps.push(Date.now());
}

// fal.ai image backend
const falClient = await import("@fal-ai/client");
const fal = falClient.fal;
fal.config({ credentials: process.env.FAL_KEY });
console.log("fal.ai backend loaded");

const app = express();
app.use(express.json());

// Serve landing page
app.use(express.static(join(ROOT, "public")));

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

  // Determine price from requested model + batch discount
  const count = Math.min(Math.max(num_images || 1, 1), 4);
  const perImage = getPricing(model);
  const batchDiscount = count >= 4 ? 0.80 : count >= 3 ? 0.90 : 1.0;
  const totalPrice = String(Math.round(Number(perImage.price) * count * batchDiscount));
  const totalUsd = (Number(totalPrice) / 1_000_000).toFixed(2);
  const desc = count > 1
    ? `Generate ${count} images for ${totalUsd} USDC (${perImage.tier}, ${batchDiscount < 1 ? Math.round((1 - batchDiscount) * 100) + "% batch discount" : "no discount"})`
    : `Generate an image for ${perImage.usd} USDC (${perImage.tier} tier)`;

  // --- No credential → 402 challenge ---
  if (!authHeader || !authHeader.startsWith("Payment ")) {
    const { statusCode, headers, body } = createChallenge({
      amount: totalPrice,
      description: desc,
    });
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    return res.status(statusCode).json(body);
  }

  // --- Verify credential ---
  const { ok, error, credential } = await verifyCredential(authHeader, totalPrice);
  if (!ok) {
    const { statusCode, headers, body } = createChallenge({
      amount: totalPrice,
      description: desc,
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

  // --- Call fal.ai ---
  try {
    const usedModel = model || DEFAULT_MODEL;
    if (!BASE_PRICING[usedModel]) {
      return res.status(400).json({
        type: "https://paymentauth.org/problems/bad-request",
        title: "Unsupported Model",
        status: 400,
        detail: `Model '${usedModel}' is not supported. Use: ${Object.keys(BASE_PRICING).join(", ")}`,
      });
    }

    const result = await fal.subscribe(usedModel, {
      input: {
        prompt,
        image_size: image_size || "landscape_4_3",
        num_images: Math.min(num_images || 1, 4),
      },
    });
    const images = result.data?.images || [];
    const timings = result.data?.timings;

    trackRequest();
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
  const multiplier = getDemandMultiplier();
  const tiers = Object.entries(BASE_PRICING).map(([model, info]) => {
    const price = Math.round(info.base * multiplier);
    return {
      model,
      tier: info.tier,
      base_price: String(info.base),
      current_price: String(price),
      price_usd: (price / 1_000_000).toFixed(2),
    };
  });
  res.set("Cache-Control", "no-cache");
  res.json({
    currency: "USDC",
    decimals: 6,
    demand_multiplier: multiplier,
    surge: multiplier > 1 ? `${multiplier}x surge pricing active` : "normal",
    tiers,
  });
});

// ---------------------------------------------------------------------------
// Demo endpoint: POST /api/demo (free, rate-limited by IP)
// ---------------------------------------------------------------------------

const DEMO_LIMIT = 3; // per IP per day
const demoUsage = new Map(); // ip -> { date, count }

app.post("/api/demo", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const today = new Date().toISOString().slice(0, 10);

  // Rate limit
  const usage = demoUsage.get(ip);
  if (usage && usage.date === today && usage.count >= DEMO_LIMIT) {
    return res.status(429).json({
      detail: `Demo limit reached (${DEMO_LIMIT}/day). Use the API with a Tempo wallet for unlimited access.`,
    });
  }

  const { prompt, model } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ detail: "A 'prompt' string is required." });
  }

  try {
    const usedModel = model || DEFAULT_MODEL;
    const result = await fal.subscribe(usedModel, {
      input: { prompt, image_size: "landscape_4_3", num_images: 1 },
    });
    // Convert fal.ai URLs to base64 to avoid CORS/expiry issues
    const falImages = result.data?.images || [];
    const images = [];
    for (const img of falImages) {
      if (img.url) {
        try {
          const imgResp = await fetch(img.url);
          const buf = Buffer.from(await imgResp.arrayBuffer());
          images.push({ b64_json: buf.toString("base64"), content_type: img.content_type || "image/jpeg" });
        } catch { images.push(img); }
      } else { images.push(img); }
    }

    // Track usage
    if (usage && usage.date === today) {
      usage.count++;
    } else {
      demoUsage.set(ip, { date: today, count: 1 });
    }

    res.json({ images, prompt, model: usedModel });
  } catch (err) {
    console.error("Demo error:", err.message);
    res.status(502).json({ detail: "Image generation failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`paid-image-api listening on ${HOST}`);
  console.log(`  POST ${HOST}/v1/images/generate  (MPP-protected, tiered pricing)`);
  console.log(`  GET  ${HOST}/v1/prices`);
  console.log(`  GET  ${HOST}/openapi.json`);
  console.log(`  GET  ${HOST}/llms.txt`);
});
