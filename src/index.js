import express from "express";
import { createHmac } from "node:crypto";
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
  // Premium tier
  "fal-ai/nano-banana-2":       { base: 150000, tier: "premium", premium: true },
  "fal-ai/nano-banana-pro":     { base: 230000, tier: "premium", premium: true },
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

// ---------------------------------------------------------------------------
// Response Cache — same prompt+model → cached result (zero cost, instant)
// ---------------------------------------------------------------------------
const imageCache = new Map(); // cacheKey → { images, timestamp }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 500;

function getCacheKey(prompt, model, imageSize) {
  const normalized = prompt.toLowerCase().trim().replace(/\s+/g, " ");
  return createHmac("sha256", "cache").update(`${normalized}|${model}|${imageSize}`).digest("hex").slice(0, 16);
}

function getCached(key) {
  const entry = imageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    imageCache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key, images, model) {
  // Evict oldest if full
  if (imageCache.size >= MAX_CACHE_SIZE) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  imageCache.set(key, { images, model, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Prompt Enhancement — auto-improve short/vague prompts
// ---------------------------------------------------------------------------
const STYLE_SUFFIXES = [
  "highly detailed, professional photography, 8k resolution",
  "cinematic lighting, sharp focus, vibrant colors",
  "masterful composition, stunning detail, award-winning",
];

function enhancePrompt(prompt, model) {
  const trimmed = prompt.trim();
  // Don't enhance if already detailed (>80 chars) or user explicitly opts out
  if (trimmed.length > 80 || trimmed.startsWith("raw:")) {
    return trimmed.replace(/^raw:/, "").trim();
  }
  // Pick consistent suffix based on prompt hash
  const hash = createHmac("sha256", "enhance").update(trimmed).digest();
  const idx = hash[0] % STYLE_SUFFIXES.length;
  return `${trimmed}, ${STYLE_SUFFIXES[idx]}`;
}

// ---------------------------------------------------------------------------
// Smart Model Routing — auto-pick best model based on prompt + budget
// ---------------------------------------------------------------------------
function autoSelectModel(prompt, maxBudget) {
  const len = prompt.trim().length;
  const hasDetail = /\b(detailed|realistic|photorealistic|cinematic|8k|4k|hdr|professional)\b/i.test(prompt);
  const hasText = /\b(text|word|letter|sign|logo|typography|write|font)\b/i.test(prompt);

  // Text-in-image → Ideogram V3 (specialized for text rendering)
  if (hasText && (!maxBudget || maxBudget >= 80000)) return "fal-ai/ideogram/v3";
  // Detailed/complex prompt → Pro or HiDream
  if (hasDetail && (!maxBudget || maxBudget >= 100000)) return "fal-ai/flux-pro/v1.1";
  if (hasDetail && (!maxBudget || maxBudget >= 80000)) return "fal-ai/hidream-i1-full";
  // Medium-length prompt → Dev
  if (len > 30 && (!maxBudget || maxBudget >= 50000)) return "fal-ai/flux/dev";
  // Short/simple → Schnell
  return "fal-ai/flux/schnell";
}

// fal.ai image backend
const falClient = await import("@fal-ai/client");
const fal = falClient.fal;
fal.config({ credentials: process.env.FAL_KEY });
console.log("fal.ai backend loaded (cache + prompt enhancement + smart routing)");

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

  // --- Call fal.ai (with cache, enhancement, smart routing) ---
  try {
    // Smart model routing: "auto" or missing → auto-select based on prompt
    const usedModel = (!model || model === "auto") ? autoSelectModel(prompt) : model;
    if (!BASE_PRICING[usedModel]) {
      return res.status(400).json({
        type: "https://paymentauth.org/problems/bad-request",
        title: "Unsupported Model",
        status: 400,
        detail: `Model '${usedModel}' is not supported. Use: auto, ${Object.keys(BASE_PRICING).join(", ")}`,
      });
    }

    const size = image_size || "landscape_4_3";
    const enhanced = enhancePrompt(prompt, usedModel);

    // Check cache first (only for single image requests)
    const cacheKey = getCacheKey(enhanced, usedModel, size);
    const cached = count === 1 ? getCached(cacheKey) : null;

    let images, timings;
    if (cached) {
      images = cached.images;
      timings = { cached: true };
      console.log(`Cache hit: ${cacheKey}`);
    } else {
      const result = await fal.subscribe(usedModel, {
        input: {
          prompt: enhanced,
          image_size: size,
          num_images: count,
        },
      });
      images = result.data?.images || [];
      timings = result.data?.timings;
      // Cache single-image results
      if (count === 1 && images.length > 0) setCache(cacheKey, images, usedModel);
    }

    trackRequest();
    const receipt = createReceipt(credential?.payload?.hash || credential?.payload?.signature?.slice(0, 20));

    res.set("Payment-Receipt", receipt);
    res.set("Cache-Control", "private");
    res.json({
      images, prompt, enhanced_prompt: enhanced, model: usedModel, timings,
      ...(cached ? { cached: true } : {}),
    });
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

const DEMO_LIMIT = 1; // per IP per day
const demoUsage = new Map(); // ip -> { date, count }

app.post("/api/demo", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const today = new Date().toISOString().slice(0, 10);

  // Rate limit
  const usage = demoUsage.get(ip);
  if (usage && usage.date === today && usage.count >= DEMO_LIMIT) {
    return res.status(429).json({
      detail: `Demo limit reached (${DEMO_LIMIT}/day). Connect a wallet for unlimited access.`,
    });
  }

  const { prompt, model } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ detail: "A 'prompt' string is required." });
  }

  try {
    const usedModel = (!model || model === "auto") ? autoSelectModel(prompt) : (model || DEFAULT_MODEL);

    // Block premium models from free demo
    const modelInfo = BASE_PRICING[usedModel];
    if (modelInfo && modelInfo.premium) {
      return res.status(403).json({ detail: `${usedModel} is a Premium model. Connect a wallet to use it.` });
    }

    const enhanced = enhancePrompt(prompt, usedModel);
    const cacheKey = getCacheKey(enhanced, usedModel, "landscape_4_3");
    const cached = getCached(cacheKey);

    let images;
    if (cached) {
      images = cached.images;
      console.log(`Demo cache hit: ${cacheKey}`);
    } else {
      const result = await fal.subscribe(usedModel, {
        input: { prompt: enhanced, image_size: "landscape_4_3", num_images: 1 },
      });
      // Convert fal.ai URLs to base64 to avoid CORS/expiry issues
      const falImages = result.data?.images || [];
      images = [];
      for (const img of falImages) {
        if (img.url) {
          try {
            const imgResp = await fetch(img.url);
            const buf = Buffer.from(await imgResp.arrayBuffer());
            images.push({ b64_json: buf.toString("base64"), content_type: img.content_type || "image/jpeg" });
          } catch { images.push(img); }
        } else { images.push(img); }
      }
      if (images.length > 0) setCache(cacheKey, images, usedModel);
    }

    // Only count non-cached as demo usage (cached = free)
    if (!cached) {
      if (usage && usage.date === today) {
        usage.count++;
      } else {
        demoUsage.set(ip, { date: today, count: 1 });
      }
    }

    res.json({ images, prompt, enhanced_prompt: enhanced, model: usedModel, cached: !!cached });
  } catch (err) {
    console.error("Demo error:", err.message);
    res.status(502).json({ detail: "Image generation failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Cache stats
app.get("/v1/stats", (_req, res) => {
  res.json({
    cache_size: imageCache.size,
    cache_max: MAX_CACHE_SIZE,
    cache_ttl_hours: CACHE_TTL_MS / 3600000,
    requests_5min: requestTimestamps.length,
    demand_multiplier: getDemandMultiplier(),
    models: Object.keys(BASE_PRICING).length,
    features: ["prompt_enhancement", "smart_routing", "response_cache", "dynamic_pricing", "batch_discount", "on_chain_verification"],
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PixelPay listening on ${HOST}`);
  console.log(`  POST ${HOST}/v1/images/generate  (MPP-protected, tiered pricing)`);
  console.log(`  GET  ${HOST}/v1/prices`);
  console.log(`  GET  ${HOST}/openapi.json`);
  console.log(`  GET  ${HOST}/llms.txt`);
});
