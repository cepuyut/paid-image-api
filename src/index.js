import express from "express";
import { createHmac } from "node:crypto";
import { createChallenge, verifyCredential, createReceipt } from "./mpp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx, tempo } from "mppx/client";
import { Redis } from "@upstash/redis";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// MPP Client — patches global fetch to auto-pay fal.ai via Tempo wallet
// ---------------------------------------------------------------------------
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
  console.error("WALLET_PRIVATE_KEY is required for MPP client payments");
  process.exit(1);
}
const walletAccount = privateKeyToAccount(WALLET_PRIVATE_KEY);
const DERIVED_WALLET_ADDRESS = walletAccount.address;

// Override WALLET_ADDRESS env so mpp.js uses the same address that pays fal.ai
if (!process.env.WALLET_ADDRESS || process.env.WALLET_ADDRESS.toLowerCase() !== DERIVED_WALLET_ADDRESS.toLowerCase()) {
  console.log(`Syncing WALLET_ADDRESS: ${process.env.WALLET_ADDRESS || '(unset)'} → ${DERIVED_WALLET_ADDRESS}`);
  process.env.WALLET_ADDRESS = DERIVED_WALLET_ADDRESS;
}

Mppx.create({
  methods: [tempo({ account: walletAccount })],
});
console.log(`MPP client initialized — wallet ${DERIVED_WALLET_ADDRESS}`);

const FAL_MPP_BASE = "https://fal.mpp.tempo.xyz";

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
  "fal-ai/flux/schnell":        { base: 29000,  tier: "schnell", maxImages: 0 },
  "fal-ai/flux/dev":            { base: 49000,  tier: "dev", maxImages: 1 },
  "fal-ai/flux-pro/v1.1":       { base: 99000,  tier: "pro", maxImages: 0 },
  // Recraft V3 (SVG + raster)
  "fal-ai/recraft-v3":          { base: 59000,  tier: "recraft", maxImages: 1 },
  // HiDream (high quality)
  "fal-ai/hidream-i1-full":     { base: 79000,  tier: "hidream", maxImages: 0 },
  // Ideogram V3 (text-in-image)
  "fal-ai/ideogram/v3":         { base: 79000,  tier: "ideogram", maxImages: 0 },
  // Premium tier (multi-reference)
  "fal-ai/nano-banana-2":       { base: 140000, tier: "premium", premium: true, maxImages: 14 },
  "fal-ai/nano-banana-pro":     { base: 190000, tier: "premium", premium: true, maxImages: 14 },
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
// Style Presets — predefined style keywords appended to prompts
// ---------------------------------------------------------------------------
const STYLE_PRESETS = {
  anime: "anime style, cel shading, vibrant colors, manga-inspired, detailed linework",
  cinematic: "cinematic lighting, dramatic composition, film grain, movie still, anamorphic lens",
  vintage: "vintage photography, faded colors, retro aesthetic, film grain, nostalgic mood",
  noir: "film noir style, high contrast, black and white, dramatic shadows, moody atmosphere",
  cyberpunk: "cyberpunk aesthetic, neon lights, futuristic, dark cityscape, holographic elements",
  watercolor: "watercolor painting, soft washes, artistic brushstrokes, delicate textures, hand-painted feel",
  "oil-painting": "oil painting style, rich textures, classical technique, impasto brushwork, museum quality",
  "pixel-art": "pixel art style, retro 16-bit graphics, crisp pixels, nostalgic game aesthetic",
  minimalist: "minimalist design, clean lines, simple composition, negative space, modern aesthetic",
  "pop-art": "pop art style, bold colors, Ben-Day dots, comic book aesthetic, Andy Warhol inspired",
};

// ---------------------------------------------------------------------------
// Prompt Enhancement — auto-improve short/vague prompts
// ---------------------------------------------------------------------------
const STYLE_SUFFIXES = [
  "highly detailed, professional photography, 8k resolution",
  "cinematic lighting, sharp focus, vibrant colors",
  "masterful composition, stunning detail, award-winning",
];

function enhancePrompt(prompt, model, { style, enhance } = {}) {
  let trimmed = prompt.trim();

  // Apply style preset if provided
  if (style && STYLE_PRESETS[style]) {
    trimmed = `${trimmed}, ${STYLE_PRESETS[style]}`;
  }

  // If enhance=true explicitly requested, always enhance regardless of length
  if (enhance === true) {
    const hash = createHmac("sha256", "enhance").update(trimmed).digest();
    const idx = hash[0] % STYLE_SUFFIXES.length;
    return `${trimmed}, ${STYLE_SUFFIXES[idx]}, ultra high quality, masterpiece`;
  }

  // Don't auto-enhance if already detailed (>80 chars) or user explicitly opts out
  if (trimmed.length > 80 || trimmed.startsWith("raw:")) {
    return trimmed.replace(/^raw:/, "").trim();
  }
  // Pick consistent suffix based on prompt hash
  const hash = createHmac("sha256", "enhance").update(trimmed).digest();
  const idx = hash[0] % STYLE_SUFFIXES.length;
  return `${trimmed}, ${STYLE_SUFFIXES[idx]}`;
}

// ---------------------------------------------------------------------------
// Public Gallery — Redis-backed, stores last 50 generated images
// ---------------------------------------------------------------------------
const MAX_GALLERY = 50;
const GALLERY_KEY = "pixelpay:gallery";
const MAX_USER_GALLERY = 100;

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

if (redis) console.log("Redis gallery connected (Upstash)");
else console.warn("Gallery: UPSTASH_REDIS_REST_URL/TOKEN not set — gallery disabled");

async function gallerySave(entry, isPublic = false) {
  if (!redis) return;
  try {
    const data = JSON.stringify(entry);
    // Always save to user's personal gallery
    if (entry.wallet) {
      const userKey = `pixelpay:user_gallery:${entry.wallet.toLowerCase()}`;
      await redis.lpush(userKey, data);
      await redis.ltrim(userKey, 0, MAX_USER_GALLERY - 1);
    }
    // Only save to public gallery if explicitly public
    if (isPublic) {
      await redis.lpush(GALLERY_KEY, data);
      await redis.ltrim(GALLERY_KEY, 0, MAX_GALLERY - 1);
    }
  } catch (err) { console.error("Gallery save error:", err.message); }
}

async function galleryList() {
  if (!redis) return [];
  try {
    const items = await redis.lrange(GALLERY_KEY, 0, MAX_GALLERY - 1);
    return items.map(item => typeof item === "string" ? JSON.parse(item) : item);
  } catch (err) { console.error("Gallery list error:", err.message); return []; }
}

async function userGalleryList(wallet) {
  if (!redis || !wallet) return [];
  try {
    const items = await redis.lrange(`pixelpay:user_gallery:${wallet.toLowerCase()}`, 0, MAX_USER_GALLERY - 1);
    return items.map(item => typeof item === "string" ? JSON.parse(item) : item);
  } catch (err) { console.error("User gallery list error:", err.message); return []; }
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

// fal.ai via MPP (no API key needed — paid via Tempo wallet)
console.log("fal.ai backend loaded via MPP (cache + prompt enhancement + smart routing)");

const app = express();
app.use(express.json({ limit: "50mb" }));

// Serve landing page
app.use(express.static(join(ROOT, "public")));

// Server config (wallet address derived from private key)
app.get("/pixelpay/config", (_req, res) => {
  res.json({ wallet_address: DERIVED_WALLET_ADDRESS });
});

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
  const { prompt, model, image_size, num_images, image_urls, style, enhance, negative_prompt, seed, private: isPrivate, wallet: reqWallet } = req.body || {};

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

    // Validate image_urls against model capability
    const modelDef = BASE_PRICING[usedModel];
    const maxRef = modelDef.maxImages || 0;
    const refs = Array.isArray(image_urls) ? image_urls : (image_urls ? [image_urls] : []);
    if (refs.length > 0 && maxRef === 0) {
      return res.status(400).json({
        type: "https://paymentauth.org/problems/bad-request",
        title: "Image Reference Not Supported",
        status: 400,
        detail: `${usedModel} is text-only and does not support reference images.`,
      });
    }
    if (refs.length > maxRef) {
      return res.status(400).json({
        type: "https://paymentauth.org/problems/bad-request",
        title: "Too Many Reference Images",
        status: 400,
        detail: `${usedModel} supports max ${maxRef} reference image(s), got ${refs.length}.`,
      });
    }

    // Validate style preset
    if (style && !STYLE_PRESETS[style]) {
      return res.status(400).json({
        type: "https://paymentauth.org/problems/bad-request",
        title: "Invalid Style",
        status: 400,
        detail: `Unknown style '${style}'. Options: ${Object.keys(STYLE_PRESETS).join(", ")}`,
      });
    }

    const size = image_size || "landscape_4_3";
    const enhanced = enhancePrompt(prompt, usedModel, { style, enhance });
    const hasRefs = refs.length > 0;

    // Check cache first (only for single image requests without references)
    const cacheKey = getCacheKey(enhanced, usedModel, size);
    const cached = (count === 1 && !hasRefs) ? getCached(cacheKey) : null;

    let images, timings, usedSeed = seed ?? null;
    if (cached) {
      images = cached.images;
      timings = { cached: true };
      console.log(`Cache hit: ${cacheKey}`);
    } else {
      const falBody = { prompt: enhanced, image_size: size, num_images: count };
      if (negative_prompt) falBody.negative_prompt = negative_prompt;
      if (seed != null) falBody.seed = Number(seed);
      if (hasRefs) {
        if (maxRef === 1) {
          falBody.image_url = refs[0];
        } else {
          falBody.image_urls = refs;
        }
      }
      const falRes = await fetch(`${FAL_MPP_BASE}/${usedModel}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(falBody),
      });
      if (!falRes.ok) throw new Error(`fal.ai MPP error: ${falRes.status}`);
      const result = await falRes.json();
      images = result.images || [];
      timings = result.timings;
      usedSeed = result.seed ?? seed ?? null;
      if (count === 1 && !hasRefs && images.length > 0) setCache(cacheKey, images, usedModel);
    }

    // Save to user's personal gallery (always) and public gallery (only if not private)
    if (images.length > 0 && !cached) {
      const imgUrl = images[0].url || null;
      if (imgUrl) {
        gallerySave({ prompt, model: usedModel, style: style || null, image_url: imgUrl, seed: usedSeed, wallet: reqWallet || null, timestamp: Date.now() }, !isPrivate);
      }
    }

    trackRequest();
    const receipt = createReceipt(credential?.payload?.hash || credential?.payload?.signature?.slice(0, 20));

    res.set("Payment-Receipt", receipt);
    res.set("Cache-Control", "private");
    res.json({
      images, prompt, enhanced_prompt: enhanced, model: usedModel, timings,
      ...(usedSeed != null ? { seed: usedSeed } : {}),
      ...(style ? { style } : {}),
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

  const { prompt, model, image_size, image_urls, style, enhance, negative_prompt, seed, private: isPrivate, wallet: reqWallet } = req.body || {};
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

    // Validate style preset
    if (style && !STYLE_PRESETS[style]) {
      return res.status(400).json({ detail: `Unknown style '${style}'. Options: ${Object.keys(STYLE_PRESETS).join(", ")}` });
    }

    // Validate reference images
    const maxRef = modelInfo ? (modelInfo.maxImages || 0) : 0;
    const refs = Array.isArray(image_urls) ? image_urls : (image_urls ? [image_urls] : []);
    if (refs.length > 0 && maxRef === 0) {
      return res.status(400).json({ detail: `${usedModel} is text-only and does not support reference images.` });
    }
    if (refs.length > maxRef) {
      return res.status(400).json({ detail: `${usedModel} supports max ${maxRef} reference image(s).` });
    }

    const size = image_size || "landscape_4_3";
    const enhanced = enhancePrompt(prompt, usedModel, { style, enhance });
    const hasRefs = refs.length > 0;
    const cacheKey = getCacheKey(enhanced, usedModel, size);
    const cached = hasRefs ? null : getCached(cacheKey);

    let images, usedSeed = seed ?? null;
    if (cached) {
      images = cached.images;
      console.log(`Demo cache hit: ${cacheKey}`);
    } else {
      const falBody = { prompt: enhanced, image_size: size, num_images: 1 };
      if (negative_prompt) falBody.negative_prompt = negative_prompt;
      if (seed != null) falBody.seed = Number(seed);
      if (hasRefs) {
        if (maxRef === 1) { falBody.image_url = refs[0]; } else { falBody.image_urls = refs; }
      }
      const falRes = await fetch(`${FAL_MPP_BASE}/${usedModel}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(falBody),
      });
      if (!falRes.ok) throw new Error(`fal.ai MPP error: ${falRes.status}`);
      const result = await falRes.json();
      usedSeed = result.seed ?? seed ?? null;
      // Convert fal.ai URLs to base64 to avoid CORS/expiry issues
      const falImages = result.images || [];
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
      if (!hasRefs && images.length > 0) setCache(cacheKey, images, usedModel);
    }

    // Only count non-cached as demo usage (cached = free)
    if (!cached) {
      if (usage && usage.date === today) {
        usage.count++;
      } else {
        demoUsage.set(ip, { date: today, count: 1 });
      }
    }

    // Save to user's personal gallery (always) and public gallery (only if not private)
    if (images.length > 0 && !cached) {
      const img0 = images[0];
      if (img0.url) {
        gallerySave({ prompt, model: usedModel, style: style || null, image_url: img0.url, wallet: reqWallet || null, timestamp: Date.now() }, !isPrivate);
      }
    }

    res.json({ images, prompt, enhanced_prompt: enhanced, model: usedModel, ...(usedSeed != null ? { seed: usedSeed } : {}), ...(style ? { style } : {}), cached: !!cached });
  } catch (err) {
    console.error("Demo error:", err.message);
    res.status(502).json({ detail: "Image generation failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Gallery API: GET /v1/gallery
// ---------------------------------------------------------------------------

app.get("/v1/gallery", async (_req, res) => {
  res.set("Cache-Control", "no-cache");
  const images = await galleryList();
  res.json({ images, total: images.length, max: MAX_GALLERY });
});

// User's personal gallery
app.get("/v1/gallery/my/:wallet", async (req, res) => {
  res.set("Cache-Control", "no-cache");
  const images = await userGalleryList(req.params.wallet);
  res.json({ images, total: images.length });
});

// Publish an image to public gallery
app.post("/v1/gallery/publish", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const { image_url, wallet, prompt, model, style, seed } = req.body || {};
  if (!image_url || !wallet) return res.status(400).json({ detail: "image_url and wallet required." });
  try {
    const entry = { prompt, model, style: style || null, image_url, seed: seed || null, wallet: wallet.toLowerCase(), timestamp: Date.now() };
    await redis.lpush(GALLERY_KEY, JSON.stringify(entry));
    await redis.ltrim(GALLERY_KEY, 0, MAX_GALLERY - 1);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ detail: "Failed to publish." });
  }
});

// Unpublish an image from public gallery
app.post("/v1/gallery/unpublish", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const { image_url, wallet } = req.body || {};
  if (!image_url || !wallet) return res.status(400).json({ detail: "image_url and wallet required." });
  try {
    const items = await redis.lrange(GALLERY_KEY, 0, MAX_GALLERY - 1);
    for (const item of items) {
      const parsed = typeof item === "string" ? JSON.parse(item) : item;
      if (parsed.image_url === image_url && parsed.wallet?.toLowerCase() === wallet.toLowerCase()) {
        await redis.lrem(GALLERY_KEY, 1, typeof item === "string" ? item : JSON.stringify(item));
        break;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ detail: "Failed to unpublish." });
  }
});

// ---------------------------------------------------------------------------
// Gallery page: GET /gallery
// ---------------------------------------------------------------------------

app.get("/gallery", (_req, res) => {
  res.sendFile(join(ROOT, "public", "gallery.html"));
});

// ---------------------------------------------------------------------------
// Style presets list: GET /v1/styles
// ---------------------------------------------------------------------------

app.get("/v1/styles", (_req, res) => {
  res.json({ styles: Object.keys(STYLE_PRESETS) });
});

// ---------------------------------------------------------------------------
// Upscale endpoint: POST /v1/images/upscale (free utility)
// ---------------------------------------------------------------------------

app.post("/v1/images/upscale", async (req, res) => {
  const { image_url } = req.body || {};
  if (!image_url) {
    return res.status(400).json({ detail: "An 'image_url' string is required (URL or base64 data URL)." });
  }
  try {
    const falRes = await fetch(`${FAL_MPP_BASE}/fal-ai/creative-upscaler`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url, scale: 2 }),
    });
    if (!falRes.ok) throw new Error(`fal.ai upscale error: ${falRes.status}`);
    const result = await falRes.json();
    res.json({ image: result.image || result.images?.[0] || null });
  } catch (err) {
    console.error("Upscale error:", err.message);
    res.status(502).json({ detail: "Upscale failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Generation History: POST /v1/history/save, GET /v1/history/:wallet
// ---------------------------------------------------------------------------
const HISTORY_MAX = 100;

app.post("/v1/history/save", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "History unavailable (Redis not configured)." });
  const { wallet, prompt, model, style, seed, image_url, image_b64 } = req.body || {};
  if (!wallet || !prompt) return res.status(400).json({ detail: "wallet and prompt are required." });
  const entry = { prompt, model, style: style || null, seed: seed ?? null, image_url: image_url || null, image_b64: image_b64 || null, timestamp: Date.now() };
  try {
    const key = `pixelpay:history:${wallet.toLowerCase()}`;
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, HISTORY_MAX - 1);
    res.json({ ok: true });
  } catch (err) {
    console.error("History save error:", err.message);
    res.status(500).json({ detail: "Failed to save history." });
  }
});

app.get("/v1/history/:wallet", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "History unavailable (Redis not configured)." });
  try {
    const key = `pixelpay:history:${req.params.wallet.toLowerCase()}`;
    const items = await redis.lrange(key, 0, HISTORY_MAX - 1);
    const history = items.map(item => typeof item === "string" ? JSON.parse(item) : item);
    res.json({ history, total: history.length });
  } catch (err) {
    console.error("History list error:", err.message);
    res.json({ history: [], total: 0 });
  }
});

// ---------------------------------------------------------------------------
// IPFS Upload via Pinata: POST /v1/nft/upload
// ---------------------------------------------------------------------------
const PINATA_JWT = process.env.PINATA_JWT || "";

app.post("/v1/nft/upload", async (req, res) => {
  if (!PINATA_JWT) return res.status(503).json({ detail: "IPFS not configured (PINATA_JWT missing)." });
  const { image_b64, content_type, metadata } = req.body || {};

  try {
    let imageIpfsHash;

    // Upload image (base64 → binary → Pinata)
    if (image_b64) {
      const imgBuf = Buffer.from(image_b64, "base64");
      const ext = (content_type || "image/png").split("/")[1] || "png";
      const boundary = "----PinataFormBoundary" + Date.now();
      const fileName = `pixelpay-${Date.now()}.${ext}`;

      const bodyParts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${content_type || "image/png"}\r\n\r\n`,
      ];
      const bodyEnd = `\r\n--${boundary}--\r\n`;

      const body = Buffer.concat([
        Buffer.from(bodyParts[0]),
        imgBuf,
        Buffer.from(bodyEnd),
      ]);

      const pinRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PINATA_JWT}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (!pinRes.ok) throw new Error(`Pinata image upload: ${pinRes.status}`);
      const pinData = await pinRes.json();
      imageIpfsHash = pinData.IpfsHash;
    }

    // Upload metadata JSON
    if (metadata && imageIpfsHash) {
      metadata.image = `ipfs://${imageIpfsHash}`;
    }
    const metaRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pinataContent: metadata || {} }),
    });
    if (!metaRes.ok) throw new Error(`Pinata metadata upload: ${metaRes.status}`);
    const metaData = await metaRes.json();

    res.json({
      image_ipfs: imageIpfsHash ? `ipfs://${imageIpfsHash}` : null,
      image_gateway: imageIpfsHash ? `https://gateway.pinata.cloud/ipfs/${imageIpfsHash}` : null,
      metadata_ipfs: `ipfs://${metaData.IpfsHash}`,
      metadata_gateway: `https://gateway.pinata.cloud/ipfs/${metaData.IpfsHash}`,
      metadata_uri: `ipfs://${metaData.IpfsHash}`,
    });
  } catch (err) {
    console.error("IPFS upload error:", err.message);
    res.status(502).json({ detail: "IPFS upload failed: " + err.message });
  }
});

// ---------------------------------------------------------------------------
// NFT Registry: track mints and listings in Redis
// ---------------------------------------------------------------------------
const NFT_CONTRACT = process.env.NFT_CONTRACT_ADDRESS || "";
const MARKET_CONTRACT = process.env.MARKETPLACE_CONTRACT_ADDRESS || "";

// Record a mint
app.post("/v1/nft/mint", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const { tokenId, wallet, prompt, model, style, seed, image_url, metadata_uri, tx_hash } = req.body || {};
  if (tokenId == null || !wallet) return res.status(400).json({ detail: "tokenId and wallet required." });

  const entry = {
    tokenId: Number(tokenId), wallet: wallet.toLowerCase(), prompt, model,
    style: style || null, seed: seed ?? null, image_url, metadata_uri,
    tx_hash, creator: wallet.toLowerCase(), timestamp: Date.now(),
  };
  try {
    await redis.set(`pixelpay:nft:${tokenId}`, JSON.stringify(entry));
    await redis.lpush(`pixelpay:nft:by_owner:${wallet.toLowerCase()}`, tokenId);
    await redis.lpush(`pixelpay:nft:by_creator:${wallet.toLowerCase()}`, tokenId);
    await redis.lpush("pixelpay:nft:all", tokenId);
    await redis.incr("pixelpay:nft:counter");
    res.json({ ok: true, nft: entry });
  } catch (err) {
    console.error("NFT mint record error:", err.message);
    res.status(500).json({ detail: "Failed to record mint." });
  }
});

// Get all active listings (MUST be before /:tokenId to avoid route conflict)
app.get("/v1/nft/listings", async (req, res) => {
  if (!redis) return res.json({ listings: [] });
  try {
    const ids = await redis.lrange("pixelpay:nft:listings", 0, 99);
    const listings = [];
    for (const id of ids) {
      const ld = await redis.get(`pixelpay:nft:listing:${id}`);
      if (!ld) continue;
      const listing = typeof ld === "string" ? JSON.parse(ld) : ld;
      const nd = await redis.get(`pixelpay:nft:${id}`);
      if (!nd) continue; // skip listings with missing NFT data
      const nft = typeof nd === "string" ? JSON.parse(nd) : nd;
      listings.push({ ...listing, nft });
    }
    res.json({ listings, total: listings.length });
  } catch (err) {
    res.json({ listings: [], total: 0 });
  }
});

// Recent activity (MUST be before /:tokenId)
app.get("/v1/nft/activity", async (_req, res) => {
  if (!redis) return res.json({ activity: [] });
  try {
    const sales = await redis.lrange("pixelpay:nft:sales", 0, 19);
    const parsed = sales.map(s => typeof s === "string" ? JSON.parse(s) : s);
    res.json({ sales: parsed, activity: parsed, total: parsed.length });
  } catch (err) {
    res.json({ activity: [], total: 0 });
  }
});

// Get all NFTs by owner (MUST be before /:tokenId)
app.get("/v1/nft/by-owner/:wallet", async (req, res) => {
  if (!redis) return res.json({ nfts: [] });
  try {
    const ids = await redis.lrange(`pixelpay:nft:by_owner:${req.params.wallet.toLowerCase()}`, 0, 199);
    const nfts = [];
    for (const id of ids) {
      const data = await redis.get(`pixelpay:nft:${id}`);
      if (data) nfts.push(typeof data === "string" ? JSON.parse(data) : data);
    }
    res.json({ nfts, total: nfts.length });
  } catch (err) {
    res.json({ nfts: [], total: 0 });
  }
});

// Get all NFTs by creator (MUST be before /:tokenId)
app.get("/v1/nft/by-creator/:wallet", async (req, res) => {
  if (!redis) return res.json({ nfts: [] });
  try {
    const ids = await redis.lrange(`pixelpay:nft:by_creator:${req.params.wallet.toLowerCase()}`, 0, 199);
    const nfts = [];
    for (const id of ids) {
      const data = await redis.get(`pixelpay:nft:${id}`);
      if (data) nfts.push(typeof data === "string" ? JSON.parse(data) : data);
    }
    res.json({ nfts, total: nfts.length });
  } catch (err) {
    res.json({ nfts: [], total: 0 });
  }
});

// Get NFT by tokenId (dynamic route MUST be after static routes)
app.get("/v1/nft/:tokenId", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  try {
    const data = await redis.get(`pixelpay:nft:${req.params.tokenId}`);
    if (!data) return res.status(404).json({ detail: "NFT not found." });
    const nft = typeof data === "string" ? JSON.parse(data) : data;
    const listingData = await redis.get(`pixelpay:nft:listing:${req.params.tokenId}`);
    const listing = listingData ? (typeof listingData === "string" ? JSON.parse(listingData) : listingData) : null;
    res.json({ nft, listing });
  } catch (err) {
    res.status(500).json({ detail: "Failed to fetch NFT." });
  }
});

// Record a listing
app.post("/v1/nft/list", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const { tokenId, seller, price } = req.body || {};
  if (tokenId == null || !seller || !price) return res.status(400).json({ detail: "tokenId, seller, price required." });
  try {
    // Verify seller owns this NFT
    const nd = await redis.get(`pixelpay:nft:${tokenId}`);
    if (!nd) return res.status(404).json({ detail: "NFT not found." });
    const nft = typeof nd === "string" ? JSON.parse(nd) : nd;
    if (nft.wallet?.toLowerCase() !== seller.toLowerCase()) {
      return res.status(403).json({ detail: "You don't own this NFT." });
    }
    // Check not already listed
    const existing = await redis.get(`pixelpay:nft:listing:${tokenId}`);
    if (existing) return res.status(409).json({ detail: "NFT already listed." });

    const listing = { tokenId: Number(tokenId), seller: seller.toLowerCase(), price, listedAt: Date.now() };
    await redis.set(`pixelpay:nft:listing:${tokenId}`, JSON.stringify(listing));
    await redis.lpush("pixelpay:nft:listings", tokenId);
    res.json({ ok: true, listing });
  } catch (err) {
    res.status(500).json({ detail: "Failed to record listing." });
  }
});

// Record a sale (remove listing)
app.post("/v1/nft/buy", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const { tokenId, buyer, tx_hash } = req.body || {};
  if (tokenId == null || !buyer || !tx_hash) return res.status(400).json({ detail: "tokenId, buyer, and tx_hash required." });
  try {
    // Verify listing exists
    const ld = await redis.get(`pixelpay:nft:listing:${tokenId}`);
    if (!ld) return res.status(404).json({ detail: "Listing not found." });
    const listing = typeof ld === "string" ? JSON.parse(ld) : ld;

    // Prevent self-buy
    if (listing.seller === buyer.toLowerCase()) {
      return res.status(400).json({ detail: "Cannot buy your own listing." });
    }

    // Record sale with NFT metadata for activity feed
    const nd = await redis.get(`pixelpay:nft:${tokenId}`);
    const nft = nd ? (typeof nd === "string" ? JSON.parse(nd) : nd) : null;
    const sale = {
      tokenId: Number(tokenId), buyer: buyer.toLowerCase(), seller: listing.seller,
      price: listing.price, tx_hash, timestamp: Date.now(),
      image_url: nft?.image_url || null, name: nft?.prompt || null,
    };
    await redis.lpush("pixelpay:nft:sales", JSON.stringify(sale));

    // Remove listing
    await redis.del(`pixelpay:nft:listing:${tokenId}`);
    await redis.lrem("pixelpay:nft:listings", 1, tokenId);

    // Transfer ownership in backend
    if (nft) {
      const oldOwner = nft.wallet;
      nft.wallet = buyer.toLowerCase();
      await redis.set(`pixelpay:nft:${tokenId}`, JSON.stringify(nft));
      await redis.lpush(`pixelpay:nft:by_owner:${buyer.toLowerCase()}`, tokenId);
      if (oldOwner) await redis.lrem(`pixelpay:nft:by_owner:${oldOwner}`, 1, tokenId);
    }
    res.json({ ok: true, sale });
  } catch (err) {
    res.status(500).json({ detail: "Failed to record sale." });
  }
});

// Cancel a listing (requires seller query param for validation)
app.delete("/v1/nft/listing/:tokenId", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const seller = req.query.seller;
  try {
    const ld = await redis.get(`pixelpay:nft:listing:${req.params.tokenId}`);
    if (!ld) return res.status(404).json({ detail: "Listing not found." });
    const listing = typeof ld === "string" ? JSON.parse(ld) : ld;
    // Verify the caller is the seller
    if (seller && listing.seller !== seller.toLowerCase()) {
      return res.status(403).json({ detail: "Only the seller can cancel." });
    }
    await redis.del(`pixelpay:nft:listing:${req.params.tokenId}`);
    await redis.lrem("pixelpay:nft:listings", 1, req.params.tokenId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ detail: "Failed to cancel listing." });
  }
});

// NFT stats
app.get("/v1/nft/stats", async (_req, res) => {
  if (!redis) return res.json({ minted: 0 });
  try {
    const count = await redis.get("pixelpay:nft:counter");
    res.json({ minted: Number(count) || 0 });
  } catch(_) { res.json({ minted: 0 }); }
});

// NFT contract info
app.get("/pixelpay/nft-config", (_req, res) => {
  res.json({
    nft_contract: process.env.NFT_CONTRACT_ADDRESS || NFT_CONTRACT,
    marketplace_contract: process.env.MARKETPLACE_CONTRACT_ADDRESS || MARKET_CONTRACT,
  });
});

// Serve marketplace page
app.get("/marketplace", (_req, res) => {
  res.sendFile(join(ROOT, "public", "marketplace.html"));
});

// Serve swap page
app.get("/swap", (_req, res) => {
  res.sendFile(join(ROOT, "public", "swap.html"));
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
    features: ["prompt_enhancement", "smart_routing", "response_cache", "dynamic_pricing", "batch_discount", "on_chain_verification", "reference_images", "style_presets", "prompt_enhance", "public_gallery", "negative_prompt", "seed_control", "variations", "generation_history", "image_upscaler", "nft_minting", "nft_marketplace", "ipfs_upload"],
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
