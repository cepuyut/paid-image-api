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
const PRICING_TIERS = {
  "fal-ai/flux/schnell":   { price: "30000",  usd: "0.03", tier: "schnell" },
  "fal-ai/flux/dev":       { price: "50000",  usd: "0.05", tier: "dev" },
  "fal-ai/flux-pro/v1.1":  { price: "100000", usd: "0.10", tier: "pro" },
};
const DEFAULT_MODEL = "fal-ai/flux/schnell";
const DEFAULT_PRICE = { price: "30000", usd: "0.03", tier: "schnell" };

function getPricing(model) {
  return PRICING_TIERS[model] || DEFAULT_PRICE;
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

  // Determine price from requested model
  const pricing = getPricing(model);

  // --- No credential → 402 challenge ---
  if (!authHeader || !authHeader.startsWith("Payment ")) {
    const { statusCode, headers, body } = createChallenge({
      amount: pricing.price,
      description: `Generate an image for ${pricing.usd} USDC (${pricing.tier} tier)`,
    });
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    return res.status(statusCode).json(body);
  }

  // --- Verify credential ---
  const { ok, error, credential } = await verifyCredential(authHeader, pricing.price);
  if (!ok) {
    const { statusCode, headers, body } = createChallenge({
      amount: pricing.price,
      description: `Generate an image for ${pricing.usd} USDC (${pricing.tier} tier)`,
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
    if (!PRICING_TIERS[usedModel]) {
      return res.status(400).json({
        type: "https://paymentauth.org/problems/bad-request",
        title: "Unsupported Model",
        status: 400,
        detail: `Model '${usedModel}' is not supported. Use: ${Object.keys(PRICING_TIERS).join(", ")}`,
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
  res.json({ currency: "USDC", decimals: 6, tiers });
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
