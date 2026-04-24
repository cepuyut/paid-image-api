import express from "express";
import { createHmac } from "node:crypto";
import { createChallenge, verifyCredential, createReceipt, setMppRedis } from "./mpp.js";
import { initX402, detectProtocol, buildX402Challenge, verifyX402Payment, buildX402Receipt } from "./x402.js";
import { readFileSync, readFile } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
const readFileAsync = promisify(readFile);
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from "viem";
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

// Initialize x402 for dual-protocol support (Base USDC)
const x402Enabled = initX402();

const FAL_MPP_BASE = "https://fal.mpp.tempo.xyz";

// ---------------------------------------------------------------------------
// PXP Token — reward minting via backend wallet
// ---------------------------------------------------------------------------
const PXP_TOKEN = process.env.PXP_TOKEN_ADDRESS || "";
const PXP_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const PATHUSD = process.env.PATHUSD_ADDRESS || "0x20C0000000000000000000000000000000000000";
const USDC_TOKEN_ADDR = process.env.USDC_TOKEN_ADDRESS || "0x20c000000000000000000000b9537d11c60e8b50";
const MARKETPLACE_BUY_ABI = parseAbi(["function buy(uint256 tokenId) external"]);
const NFT_TRANSFER_ABI = parseAbi(["function transferFrom(address from, address to, uint256 tokenId)"]);
const USDC_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const tempoChain = defineChain({
  id: 4217, name: "Tempo",
  nativeCurrency: { name: "pathUSD", symbol: "pUSD", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.tempo.xyz"] } },
});
const pxpPublicClient = createPublicClient({ chain: tempoChain, transport: http() });
const pxpWalletClient = createWalletClient({ chain: tempoChain, transport: http(), account: walletAccount });

// ---------------------------------------------------------------------------
// PXP Rewards — Satoshi-style halving tokenomics
// Max supply: 21,000,000 PXP | Pre-minted: 15% (3,150,000) | Rewards: 85% (17,850,000)
// Halving every 25% of reward pool minted (4 eras)
// ---------------------------------------------------------------------------
const PXP_REWARD_POOL = 17_850_000n * 10n**18n;        // 85% of 21M
const PXP_HALVING_INTERVAL = PXP_REWARD_POOL / 4n;     // 4,462,500 PXP per era
const PXP_PREMINT = 3_150_000n * 10n**18n;              // 15% pre-minted at deploy

// Base rates (Era 1 = 1x) — on-chain activity only
const PXP_BASE_RATES = {
  generate:   5n * 10n**18n,       // 5 PXP per image generate
  edit:       3n * 10n**18n,       // 3 PXP per edit
  transform:  2n * 10n**18n,       // 2 PXP per transform
  video:     10n * 10n**18n,       // 10 PXP per video
  mint_nft:   5n * 10n**18n,       // 5 PXP per NFT mint
};

// Cache: current era + total rewards minted (refresh every 60s)
let pxpRewardsCache = { totalMinted: 0n, era: 1, multiplier: 1n, denominator: 1n, lastCheck: 0 };

async function refreshPxpEra() {
  if (!PXP_TOKEN) return;
  const now = Date.now();
  if (now - pxpRewardsCache.lastCheck < 60_000) return; // cache 60s
  try {
    const totalSupply = await pxpPublicClient.readContract({
      address: PXP_TOKEN, abi: PXP_ABI, functionName: "totalSupply",
    });
    const rewardsMinted = totalSupply - PXP_PREMINT;
    const era = Number(rewardsMinted / PXP_HALVING_INTERVAL) + 1;
    // Multiplier: era1=1/1, era2=1/2, era3=1/4, era4=1/8, era5+=0
    const clampedEra = Math.min(era, 4);
    const denominator = BigInt(2 ** (clampedEra - 1)); // 1, 2, 4, 8
    pxpRewardsCache = {
      totalMinted: rewardsMinted > 0n ? rewardsMinted : 0n,
      era: clampedEra,
      multiplier: era > 4 ? 0n : 1n,
      denominator,
      lastCheck: now,
    };
    console.log(`PXP era: ${clampedEra} | minted: ${Number(rewardsMinted / 10n**18n)} / ${Number(PXP_REWARD_POOL / 10n**18n)} | rate: 1/${denominator}`);
  } catch (err) {
    console.error("PXP era check error:", err.message);
  }
}

function getHalvedReward(action) {
  const base = PXP_BASE_RATES[action];
  if (!base) return 0n;
  if (pxpRewardsCache.multiplier === 0n) return 0n; // all rewards minted
  return base / pxpRewardsCache.denominator;
}

async function mintPXP(toAddress, action, reason) {
  if (!PXP_TOKEN || !toAddress) return null;
  await refreshPxpEra();
  const amount = getHalvedReward(action);
  if (amount === 0n) {
    console.log(`PXP reward: EXHAUSTED — no more rewards to mint (${reason})`);
    return null;
  }
  try {
    const hash = await pxpWalletClient.writeContract({
      address: PXP_TOKEN,
      abi: PXP_ABI,
      functionName: "mint",
      args: [toAddress, amount],
      feeToken: PATHUSD,
    });
    console.log(`PXP reward: ${Number(amount * 1000n / 10n**18n) / 1000} PXP → ${toAddress.slice(0,8)}... (${reason}, era ${pxpRewardsCache.era}) tx:${hash.slice(0,10)}`);
    return hash;
  } catch (err) {
    console.error("PXP mint error:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Tiered pricing per model (base units, 6 decimals: 1 USDC = 1_000_000)
// Margin target: ~18% over fal.ai cost. Formula: cost × 1.18, floor $0.004.
// ---------------------------------------------------------------------------
const BASE_PRICING = {
  // Flux family (cost: schnell ~$0.003, dev ~$0.025, pro ~$0.055)
  "fal-ai/flux/schnell":        { base: 4000,   tier: "schnell", type: "image", maxImages: 0 },
  "fal-ai/flux/dev":            { base: 30000,  tier: "dev", type: "image", maxImages: 1 },
  "fal-ai/flux-pro/v1.1":       { base: 65000,  tier: "pro", type: "image", maxImages: 0 },
  // Recraft V3 (SVG + raster, cost ~$0.040)
  "fal-ai/recraft-v3":          { base: 47000,  tier: "recraft", type: "image", maxImages: 0 },
  // HiDream (cost ~$0.050)
  "fal-ai/hidream-i1-full":     { base: 59000,  tier: "hidream", type: "image", maxImages: 0 },
  // Ideogram V3 (text-in-image, cost ~$0.080)
  "fal-ai/ideogram/v3":         { base: 94000,  tier: "ideogram", type: "image", maxImages: 0 },
  // GPT-Image-1 (OpenAI via fal.ai, cost ~$0.040)
  "fal-ai/gpt-image-1/text-to-image": { base: 47000, tier: "gpt-image", type: "image", maxImages: 0 },
  // Grok Imagine (xAI via fal.ai, cost ~$0.020)
  "xai/grok-imagine-image":     { base: 24000,  tier: "grok", type: "image", maxImages: 0 },
  // Premium tier (multi-reference, cost: banana-2 ~$0.050, pro ~$0.100)
  "fal-ai/nano-banana-2":       { base: 59000,  tier: "premium", type: "image", premium: true, maxImages: 14 },
  "fal-ai/nano-banana-pro":     { base: 118000, tier: "premium", type: "image", premium: true, maxImages: 14 },
  // Edit (inpainting/outpainting, cost ~$0.050)
  "fal-ai/flux-pro/v1/fill":    { base: 59000,  tier: "edit", type: "edit", maxImages: 1 },
  // Transform (style transfer / remix, cost ~$0.040)
  "fal-ai/flux-kontext/text-to-image": { base: 47000, tier: "transform", type: "transform", maxImages: 1 },
  // Video generation (Seedance 1.0 Pro Fast, cost ~$0.250 for 5s)
  "fal-ai/bytedance/seedance/v1/pro/fast/text-to-video": { base: 295000, tier: "video", type: "video", maxImages: 0 },
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
  const now = Date.now();
  requestTimestamps.push(now);
  // Clean old timestamps to prevent unbounded growth
  while (requestTimestamps.length && requestTimestamps[0] < now - REQUEST_WINDOW_MS) {
    requestTimestamps.shift();
  }
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
// SSRF protection — validate image URLs before forwarding
// ---------------------------------------------------------------------------
function validateImageUrl(url) {
  if (!url) return;
  // Allow data URLs (base64 images from client uploads)
  if (url.startsWith("data:image/")) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs allowed");
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
        host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.") ||
        host.endsWith(".internal") || host.endsWith(".local") ||
        host === "169.254.169.254" || host.startsWith("169.254.")) {
      throw new Error("Internal URLs not allowed");
    }
  } catch (e) {
    if (e.message === "Only HTTPS URLs allowed" || e.message === "Internal URLs not allowed") throw e;
    throw new Error("Invalid URL format");
  }
}

// ---------------------------------------------------------------------------
// Model-specific body mapper — adapts params for each fal.ai model's API
// ---------------------------------------------------------------------------

// Size mapping for models that use fixed pixel sizes instead of aspect keywords
const PIXEL_SIZE_MAP = {
  "square_hd": "1024x1024", "square": "1024x1024",
  "landscape_4_3": "1024x768", "landscape_16_9": "1024x576",
  "portrait_4_3": "768x1024", "portrait_16_9": "576x1024",
  "portrait_9_16": "576x1024", "widescreen_21_9": "1024x448",
};

const ASPECT_RATIO_MAP = {
  "square_hd": "1:1", "square": "1:1",
  "landscape_4_3": "4:3", "landscape_16_9": "16:9",
  "portrait_4_3": "3:4", "portrait_16_9": "9:16",
  "portrait_9_16": "9:16", "widescreen_21_9": "21:9",
};

function buildFalBody(model, { prompt, image_size, num_images, negative_prompt, seed, image_urls }) {
  const size = image_size || "landscape_4_3";
  const count = num_images || 1;
  const refs = Array.isArray(image_urls) ? image_urls : (image_urls ? [image_urls] : []);
  const modelDef = BASE_PRICING[model] || {};
  const maxRef = modelDef.maxImages || 0;

  // --- GPT-Image-1: uses "size" as "1024x1024" pixel string ---
  if (model === "fal-ai/gpt-image-1/text-to-image") {
    const body = { prompt, size: PIXEL_SIZE_MAP[size] || "1024x1024", num_images: count };
    // GPT-Image-1 does not support negative_prompt, seed, or ref images
    return body;
  }

  // --- Grok Imagine: uses "aspect_ratio" as "4:3" string ---
  if (model === "xai/grok-imagine-image") {
    const body = { prompt, aspect_ratio: ASPECT_RATIO_MAP[size] || "4:3", num_images: count };
    // Grok does not support negative_prompt, seed, or ref images
    return body;
  }

  // --- FLUX Fill (edit/inpainting): requires image + mask ---
  if (model === "fal-ai/flux-pro/v1/fill") {
    const body = { prompt, image_size: resolveImageSize(size) };
    if (refs.length > 0) body.image_url = refs[0];
    // mask_url can be passed via image_urls[1] if provided
    if (refs.length > 1) body.mask_url = refs[1];
    return body;
  }

  // --- FLUX Kontext (transform/remix): reference image + prompt ---
  if (model === "fal-ai/flux-kontext/text-to-image") {
    const body = { prompt, image_size: resolveImageSize(size), num_images: count };
    if (refs.length > 0) body.image_url = refs[0];
    if (negative_prompt) body.negative_prompt = negative_prompt;
    if (seed != null) body.seed = Number(seed);
    return body;
  }

  // --- Seedance Video: image_url as starting frame, prompt for motion ---
  if (model === "fal-ai/bytedance/seedance/v1/pro/fast/text-to-video") {
    const body = { prompt, duration: 5 };
    if (refs.length > 0) body.image_url = refs[0];
    if (seed != null) body.seed = Number(seed);
    return body;
  }

  // --- FLUX Dev with reference → use /image-to-image endpoint ---
  if (model === "fal-ai/flux/dev" && refs.length > 0) {
    const body = { prompt, image_url: refs[0], image_size: resolveImageSize(size), num_images: count, strength: 0.85 };
    if (negative_prompt) body.negative_prompt = negative_prompt;
    if (seed != null) body.seed = Number(seed);
    body._endpointSuffix = "/image-to-image";
    return body;
  }

  // --- Nano Banana 2 / Pro with references → use /edit endpoint ---
  if ((model === "fal-ai/nano-banana-2" || model === "fal-ai/nano-banana-pro") && refs.length > 0) {
    const body = { prompt, image_urls: refs, num_images: count };
    if (seed != null) body.seed = Number(seed);
    body._endpointSuffix = "/edit";
    return body;
  }

  // --- Default (FLUX Schnell/Pro, Recraft, HiDream, Ideogram, Nano Banana text-only) ---
  // fal.ai does NOT accept "widescreen_21_9" as an enum — convert to explicit {width,height}.
  const sizeField = resolveImageSize(size);
  const body = { prompt, image_size: sizeField, num_images: count };
  if (negative_prompt) body.negative_prompt = negative_prompt;
  if (seed != null) body.seed = Number(seed);
  // Note: Recraft V3 reference requires /create-style workflow — not supported via simple upload.
  // For now, Recraft refs are dropped silently. Only FLUX Dev and Nano Banana support refs.
  return body;
}

// fal.ai's accepted enums: square_hd, square, portrait_4_3, portrait_16_9,
// landscape_4_3, landscape_16_9. Anything else must be sent as {width, height}.
const FAL_ENUM_SIZES = new Set([
  "square_hd", "square",
  "portrait_4_3", "portrait_16_9",
  "landscape_4_3", "landscape_16_9",
]);
function resolveImageSize(size) {
  if (typeof size !== "string") return "landscape_4_3";
  if (FAL_ENUM_SIZES.has(size)) return size;
  const pixels = PIXEL_SIZE_MAP[size];
  if (pixels) {
    const [w, h] = pixels.split("x").map(Number);
    if (w && h) return { width: w, height: h };
  }
  // Unknown alias — fall back to a safe default rather than crashing the call.
  return "landscape_4_3";
}

// Resolve actual fal.ai endpoint — some models need sub-endpoints for image refs
function resolveFalEndpoint(model, falBody) {
  if (falBody._endpointSuffix) {
    const suffix = falBody._endpointSuffix;
    delete falBody._endpointSuffix;
    return `${model}${suffix}`;
  }
  return model;
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

if (redis) {
  console.log("Redis gallery connected (Upstash)");
  setMppRedis(redis); // Share Redis with MPP for replay-attack persistence
} else {
  console.warn("Gallery: UPSTASH_REDIS_REST_URL/TOKEN not set — gallery disabled");
}

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
  const hasCreative = /\b(creative|artistic|illustration|cartoon|concept art|imagination)\b/i.test(prompt);

  // Text-in-image → Ideogram V3 (specialized for text rendering)
  if (hasText && (!maxBudget || maxBudget >= 80000)) return "fal-ai/ideogram/v3";
  // Detailed/complex prompt → Pro or HiDream
  if (hasDetail && (!maxBudget || maxBudget >= 100000)) return "fal-ai/flux-pro/v1.1";
  if (hasDetail && (!maxBudget || maxBudget >= 80000)) return "fal-ai/hidream-i1-full";
  // Creative/artistic → GPT-Image (great at creative interpretation)
  if (hasCreative && (!maxBudget || maxBudget >= 70000)) return "fal-ai/gpt-image-1/text-to-image";
  // Medium-length prompt → Dev
  if (len > 30 && (!maxBudget || maxBudget >= 50000)) return "fal-ai/flux/dev";
  // Budget-conscious short prompt → Grok (cheapest after Schnell)
  if (len <= 20 && maxBudget && maxBudget < 40000) return "xai/grok-imagine-image";
  // Short/simple → Schnell
  return "fal-ai/flux/schnell";
}

// fal.ai via MPP (no API key needed — paid via Tempo wallet)
console.log(`fal.ai backend loaded via MPP + ${x402Enabled ? "x402" : "MPP-only"} (cache + enhancement + routing)`);

// ---------------------------------------------------------------------------
// Dual-Protocol Payment Handler — MPP + x402 on every paid endpoint
// ---------------------------------------------------------------------------

async function handlePayment(req, res, { totalPrice, description, path }) {
  const protocol = detectProtocol(req);

  // No credentials → send dual 402 challenge (MPP + x402 headers)
  if (!protocol) {
    const { statusCode, headers, body } = createChallenge({ amount: totalPrice, description });
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    // Add x402 PAYMENT-REQUIRED header alongside MPP WWW-Authenticate
    if (x402Enabled) {
      const x402Header = buildX402Challenge(totalPrice, description, path);
      if (x402Header) res.set("PAYMENT-REQUIRED", x402Header);
    }
    res.status(statusCode).json(body);
    return { ok: false, sent: true };
  }

  // MPP credential
  if (protocol === "mpp") {
    const authHeader = req.get("Authorization");
    const { ok, error, credential, payer } = await verifyCredential(authHeader, totalPrice);
    if (!ok) {
      const { statusCode, headers, body } = createChallenge({ amount: totalPrice, description });
      body.type = `https://paymentauth.org/problems/${error}`;
      body.title = error.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      body.detail = `Payment verification failed: ${error}`;
      for (const [k, v] of Object.entries(headers)) res.set(k, v);
      if (x402Enabled) {
        const x402Header = buildX402Challenge(totalPrice, description, path);
        if (x402Header) res.set("PAYMENT-REQUIRED", x402Header);
      }
      res.status(402).json(body);
      return { ok: false, sent: true };
    }
    return { ok: true, protocol: "mpp", credential, payer };
  }

  // x402 credential
  if (protocol === "x402") {
    if (!x402Enabled) {
      res.status(501).json({ detail: "x402 payments not configured on this server." });
      return { ok: false, sent: true };
    }
    const { ok, error, txHash, payer } = await verifyX402Payment(req, totalPrice, path);
    if (!ok) {
      res.status(402).json({
        type: `https://paymentauth.org/problems/${error}`,
        title: "Payment Failed",
        status: 402,
        detail: `x402 payment verification failed: ${error}`,
      });
      return { ok: false, sent: true };
    }
    return { ok: true, protocol: "x402", txHash, payer };
  }

  res.status(400).json({ detail: "Unknown payment protocol." });
  return { ok: false, sent: true };
}

// Set payment receipt headers based on protocol used
function setPaymentReceipt(res, paymentResult) {
  if (paymentResult.protocol === "mpp") {
    const receipt = createReceipt(paymentResult.credential?.payload?.hash || paymentResult.credential?.payload?.signature?.slice(0, 20));
    res.set("Payment-Receipt", receipt);
  } else if (paymentResult.protocol === "x402") {
    const x402Receipt = buildX402Receipt(paymentResult.txHash, paymentResult.network);
    if (x402Receipt) res.set("PAYMENT-RESPONSE", x402Receipt);
  }
}

// Pre-read static files at startup (avoid blocking readFileSync in handlers)
let openApiDoc, llmsTxt;
try { openApiDoc = JSON.parse(readFileSync(join(ROOT, "openapi.json"), "utf8")); } catch { openApiDoc = null; }
try { llmsTxt = readFileSync(join(ROOT, "llms.txt"), "utf8"); } catch { llmsTxt = null; }

const app = express();
app.set("trust proxy", 1); // Trust first proxy (Render)
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
  if (!openApiDoc) return res.status(404).json({ detail: "openapi.json not found." });
  res.set("Cache-Control", "max-age=300");
  res.json(openApiDoc);
});

// ---------------------------------------------------------------------------
// LLM-friendly docs: GET /llms.txt
// ---------------------------------------------------------------------------

app.get("/llms.txt", (_req, res) => {
  if (!llmsTxt) return res.status(404).send("llms.txt not found.");
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "max-age=300");
  res.send(llmsTxt);
});

// ---------------------------------------------------------------------------
// MPP Well-Known Discovery: GET /.well-known/mpp.json
// ---------------------------------------------------------------------------

app.get("/.well-known/mpp.json", (_req, res) => {
  res.set("Cache-Control", "max-age=300");
  res.json({
    version: "1.0",
    service: "PixelPay",
    description: "AI image & video generation API — pay-per-request via MPP (Tempo) or x402 (Base)",
    protocols: ["mpp", "x402"],
    endpoints: [
      {
        path: "/v1/images/generate",
        method: "POST",
        description: "Generate an image from a text prompt (13 models)",
        payment: [
          { protocol: "mpp", chain: "tempo", chainId: 4217, currency: "USDC", priceRange: { min: "0.004", max: "0.118", unit: "USD" } },
          { protocol: "x402", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", priceRange: { min: "0.004", max: "0.118", unit: "USD" } }
        ]
      },
      {
        path: "/v1/images/edit",
        method: "POST",
        description: "Edit an image via inpainting/outpainting",
        payment: [
          { protocol: "mpp", chain: "tempo", chainId: 4217, currency: "USDC", priceRange: { min: "0.059", max: "0.059", unit: "USD" } },
          { protocol: "x402", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", priceRange: { min: "0.059", max: "0.059", unit: "USD" } }
        ]
      },
      {
        path: "/v1/images/transform",
        method: "POST",
        description: "Transform/remix an image with style transfer",
        payment: [
          { protocol: "mpp", chain: "tempo", chainId: 4217, currency: "USDC", priceRange: { min: "0.047", max: "0.047", unit: "USD" } },
          { protocol: "x402", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", priceRange: { min: "0.047", max: "0.047", unit: "USD" } }
        ]
      },
      {
        path: "/v1/videos/generate",
        method: "POST",
        description: "Generate a 5-second video from a text prompt",
        payment: [
          { protocol: "mpp", chain: "tempo", chainId: 4217, currency: "USDC", priceRange: { min: "0.295", max: "0.295", unit: "USD" } },
          { protocol: "x402", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", priceRange: { min: "0.295", max: "0.295", unit: "USD" } }
        ]
      }
    ],
    discovery: {
      openapi: "https://pixelpayapi.com/openapi.json",
      llms: "https://pixelpayapi.com/llms.txt",
      prices: "https://pixelpayapi.com/v1/prices"
    },
    ownershipProofs: [
      "dns-txt:_mpp.pixelpayapi.com",
      "dns-txt:_mpp-ownership.pixelpayapi.com",
      "dns-txt:pixelpayapi.com"
    ],
    serviceId: "7b1a3b88-18c6-4a54-805f-3b4340c74595"
  });
});

// ---------------------------------------------------------------------------
// x402 Well-Known Discovery: GET /.well-known/x402
// Per IETF draft-jeftovic-x402-dns-discovery-00
// ---------------------------------------------------------------------------

app.get("/.well-known/x402", (_req, res) => {
  if (!x402Enabled) return res.status(404).json({ detail: "x402 not configured" });
  res.set("Cache-Control", "max-age=300");
  res.json({
    x402Version: 2,
    service: "PixelPay",
    description: "AI image & video generation — pay with USDC on Base via x402",
    payTo: process.env.WALLET_ADDRESS,
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    facilitator: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
    resources: [
      { path: "/v1/images/generate", method: "POST", description: "Generate AI images (13 models)", maxAmountRequired: "190000", minAmountRequired: "29000" },
      { path: "/v1/images/edit", method: "POST", description: "Edit image via inpainting", maxAmountRequired: "79000" },
      { path: "/v1/images/transform", method: "POST", description: "Style transfer / remix", maxAmountRequired: "49000" },
      { path: "/v1/videos/generate", method: "POST", description: "Generate 5s video", maxAmountRequired: "350000" },
    ],
    discovery: {
      openapi: "https://pixelpayapi.com/openapi.json",
      mpp: "https://pixelpayapi.com/.well-known/mpp.json",
      llms: "https://pixelpayapi.com/llms.txt",
    },
  });
});

// ---------------------------------------------------------------------------
// Agent instructions: GET /agents.txt
// ---------------------------------------------------------------------------

let agentsTxt;
try { agentsTxt = readFileSync(join(ROOT, "agents.txt"), "utf8"); } catch { agentsTxt = null; }

app.get("/agents.txt", (_req, res) => {
  if (!agentsTxt) return res.status(404).send("agents.txt not found.");
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "max-age=300");
  res.send(agentsTxt);
});

// ---------------------------------------------------------------------------
// Models endpoint: GET /v1/models
// ---------------------------------------------------------------------------

app.get("/v1/models", (_req, res) => {
  const models = Object.entries(BASE_PRICING).map(([id, info]) => ({
    id,
    tier: info.tier,
    type: info.type || "image",
    price_usd: (info.base / 1_000_000).toFixed(3),
    price_base_units: info.base,
    premium: !!info.premium,
    max_reference_images: info.maxImages,
    capabilities: {
      text_to_image: info.type === "image" || info.type === "transform",
      image_to_image: info.maxImages > 0,
      text_in_image: id === "fal-ai/ideogram/v3",
      vector_output: id === "fal-ai/recraft-v3",
      edit: info.type === "edit",
      video: info.type === "video",
      transform: info.type === "transform",
    },
  }));
  res.set("Cache-Control", "max-age=60");
  res.json({ models, default_model: DEFAULT_MODEL, total: models.length });
});

// ---------------------------------------------------------------------------
// Validate endpoint: POST /v1/validate
// ---------------------------------------------------------------------------

app.post("/v1/validate", (req, res) => {
  const { prompt, model } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return res.status(400).json({ valid: false, error: "prompt is required and must be a non-empty string" });
  }
  if (prompt.length > 10000) {
    return res.status(400).json({ valid: false, error: "prompt exceeds maximum length of 10000 characters" });
  }
  const resolvedModel = (!model || model === "auto") ? autoSelectModel(prompt) : model;
  const modelInfo = BASE_PRICING[resolvedModel];
  if (!modelInfo) {
    return res.status(400).json({
      valid: false,
      error: `Model '${resolvedModel}' is not supported`,
      available_models: Object.keys(BASE_PRICING),
    });
  }
  const multiplier = getDemandMultiplier();
  const price = Math.round(modelInfo.base * multiplier);
  res.json({
    valid: true,
    prompt: prompt.trim(),
    model: resolvedModel,
    tier: modelInfo.tier,
    price: String(price),
    price_usd: (price / 1_000_000).toFixed(3),
    premium: !!modelInfo.premium,
    surge_multiplier: multiplier,
  });
});

// ---------------------------------------------------------------------------
// Paid endpoint: POST /v1/images/generate
// ---------------------------------------------------------------------------

app.post("/v1/images/generate", async (req, res) => {
  // --- Short-circuit for retry credits (user paid earlier, previous gen failed) ---
  // A valid retry-token proves prior payment, so we can skip the 402 challenge here.
  const earlyRetryHeader = req.get("X-PixelPay-Retry");
  let retryShortCircuit = null;
  if (earlyRetryHeader && redis) {
    const earlyKey = `pixelpay:credit:${earlyRetryHeader}`;
    const earlyRaw = await redis.get(earlyKey).catch(() => null);
    if (earlyRaw) {
      try {
        const earlyData = typeof earlyRaw === "string" ? JSON.parse(earlyRaw) : earlyRaw;
        if (earlyData && earlyData.used !== true) {
          retryShortCircuit = { key: earlyKey, data: earlyData };
        }
      } catch { /* fall through to normal flow */ }
    }
  }

  // --- Dual-protocol payment verification FIRST (before body validation) ---
  // MPPscan and agents send empty POST to probe for 402 challenge
  const probeModel = (req.body?.model && req.body.model !== "auto") ? req.body.model : "fal-ai/flux/dev";
  const probePrice = getPricing(probeModel);
  const probeDesc = `Generate an image for ${probePrice.usd} USDC (${probePrice.tier} tier)`;
  let payment = { ok: true, payer: null };
  if (!retryShortCircuit) {
    payment = await handlePayment(req, res, { totalPrice: probePrice.price, description: probeDesc, path: "/v1/images/generate" });
    if (!payment.ok) return; // Response already sent by handlePayment (402 challenge or error)
  }

  const { prompt, model, image_size, num_images, image_urls, style, enhance, negative_prompt, seed, private: isPrivate, wallet: reqWallet } = req.body || {};

  if (!prompt || typeof prompt !== "string" || prompt.length > 10000) {
    return res.status(400).json({ detail: "A 'prompt' string is required (max 10000 chars)." });
  }

  // Resolve model first so pricing matches the actual model used
  const resolvedModel = (!model || model === "auto") ? autoSelectModel(prompt || "") : model;
  const resolvedModelDef = BASE_PRICING[resolvedModel];
  // Video models only generate 1 output — force count=1 to prevent overcharging
  const count = resolvedModelDef?.type === "video" ? 1 : Math.min(Math.max(num_images || 1, 1), 4);
  const perImage = getPricing(resolvedModel);
  const batchDiscount = count >= 4 ? 0.80 : count >= 3 ? 0.90 : 1.0;
  const totalPrice = String(Math.round(Number(perImage.price) * count * batchDiscount));
  const totalUsd = (Number(totalPrice) / 1_000_000).toFixed(2);
  const desc = count > 1
    ? `Generate ${count} images for ${totalUsd} USDC (${perImage.tier}, ${batchDiscount < 1 ? Math.round((1 - batchDiscount) * 100) + "% batch discount" : "no discount"})`
    : `Generate an image for ${perImage.usd} USDC (${perImage.tier} tier)`;

  // Security: verify payment covers actual resolved price (prevent cheap-model-pay, expensive-model-use)
  // Skip this check on retry short-circuit — the prior charge was already enforced.
  if (!retryShortCircuit && Number(totalPrice) > Number(probePrice.price)) {
    return res.status(402).json({
      detail: `Payment insufficient. You paid for ${probePrice.tier} ($${probePrice.usd}) but requested ${perImage.tier} ($${perImage.usd}). Please retry with correct model.`,
    });
  }
  // For retry, verify the stored credit amount covers the resolved price.
  if (retryShortCircuit && Number(retryShortCircuit.data.amount) < Number(totalPrice)) {
    return res.status(402).json({
      detail: `Retry credit ($${(retryShortCircuit.data.amount/1_000_000).toFixed(3)}) is less than the requested price ($${(Number(totalPrice)/1_000_000).toFixed(3)}). Downgrade model or pay the difference.`,
    });
  }

  // --- Check for retry credit (failed generation refund) ---
  const retryHeader = req.get("X-PixelPay-Retry");
  if (retryHeader && redis) {
    const creditKey = `pixelpay:credit:${retryHeader}`;
    const credit = await redis.get(creditKey).catch(() => null);
    if (credit) {
      try {
        const creditData = JSON.parse(credit);
        if (creditData.amount >= Number(totalPrice) && creditData.used !== true) {
          await redis.set(creditKey, JSON.stringify({ ...creditData, used: true }), { ex: 60 });
          console.log(`Retry credit used: ${retryHeader} for ${creditData.wallet || "unknown"}`);
          const usedModel = resolvedModel;
          if (!BASE_PRICING[usedModel]) return res.status(400).json({ detail: `Model '${usedModel}' is not supported.` });
          const size = image_size || "landscape_4_3";
          const enhanced = enhancePrompt(prompt, usedModel, { style, enhance });
          const refs = Array.isArray(image_urls) ? image_urls : (image_urls ? [image_urls] : []);
          const falBody = buildFalBody(usedModel, { prompt: enhanced, image_size: size, num_images: count, negative_prompt, seed, image_urls: refs });
          const falEndpoint = resolveFalEndpoint(usedModel, falBody);
          try {
            const falRes = await fetch(`${FAL_MPP_BASE}/${falEndpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(falBody) });
            if (!falRes.ok) throw new Error(`fal.ai error: ${falRes.status}`);
            const result = await falRes.json();
            await redis.del(creditKey).catch(() => {});
            const retryModelDef = BASE_PRICING[usedModel] || {};
            if (retryModelDef.type === "video") {
              const retryVideoUrl = result.video?.url || null;
              return res.json({ video: retryVideoUrl ? { url: retryVideoUrl } : null, prompt, enhanced_prompt: enhanced, model: usedModel, retried: true });
            }
            return res.json({ images: result.images || [], prompt, enhanced_prompt: enhanced, model: usedModel, timings: result.timings, retried: true });
          } catch (retryErr) {
            await redis.set(creditKey, JSON.stringify({ ...creditData, used: false }), { ex: 3600 }).catch(() => {});
            return res.status(502).json({ detail: "Retry failed. Your credit is still valid.", retry_token: retryHeader });
          }
        }
      } catch (_) {}
    }
  }

  // --- Call fal.ai (with cache, enhancement, smart routing) ---
  try {
    const usedModel = resolvedModel;
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
    // NEVER use cache for paid requests — users pay for fresh generations
    const cacheKey = getCacheKey(enhanced, usedModel, size);
    const cached = false; // Disabled for paid endpoint — every payment gets a fresh image

    let images, timings, usedSeed = seed ?? null;
    if (cached) {
      images = cached.images;
      timings = { cached: true };
      console.log(`Cache hit: ${cacheKey}`);
    } else {
      const falBody = buildFalBody(usedModel, { prompt: enhanced, image_size: size, num_images: count, negative_prompt, seed, image_urls: refs });
      const falEndpoint = resolveFalEndpoint(usedModel, falBody);
      const falRes = await fetch(`${FAL_MPP_BASE}/${falEndpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(falBody),
      });
      if (!falRes.ok) {
        const errText = await falRes.text().catch(() => "");
        throw new Error(`fal.ai MPP error: ${falRes.status} ${errText.slice(0, 200)}`);
      }
      const result = await falRes.json();
      // Video models return { video: { url } } instead of { images: [] }
      if (modelDef.type === "video") {
        const videoUrl = result.video?.url || null;
        return res.json({
          video: videoUrl ? { url: videoUrl } : null,
          prompt, enhanced_prompt: enhanced, model: usedModel, timings: result.timings,
          ...(usedSeed != null ? { seed: usedSeed } : {}),
        });
      }
      images = result.images || [];
      timings = result.timings;
      usedSeed = result.seed ?? seed ?? null;
      if (count === 1 && !hasRefs && images.length > 0) setCache(cacheKey, images, usedModel);
    }

    // Save to user's personal gallery (always) — public only if explicitly set to public (private: false)
    if (images.length > 0 && !cached) {
      const imgUrl = images[0].url || null;
      if (imgUrl) {
        const publishToPublic = isPrivate === false; // Must explicitly opt-in to public
        gallerySave({ prompt, model: usedModel, style: style || null, image_url: imgUrl, seed: usedSeed, wallet: reqWallet || null, timestamp: Date.now() }, publishToPublic);
      }
      // PXP reward for generating
      if (payment.payer) mintPXP(payment.payer, "generate", "generate").catch(() => {});
    }

    trackRequest();
    setPaymentReceipt(res, payment);

    res.set("Cache-Control", "private");
    res.json({
      images, prompt, enhanced_prompt: enhanced, model: usedModel, timings,
      ...(usedSeed != null ? { seed: usedSeed } : {}),
      ...(style ? { style } : {}),
      ...(cached ? { cached: true } : {}),
    });
  } catch (err) {
    console.error("Image backend error:", err && err.stack ? err.stack : err);
    let retryToken = null;
    if (retryShortCircuit && redis) {
      // Short-circuit retry failed again — restore the original credit so user can try once more.
      retryToken = earlyRetryHeader;
      await redis.set(retryShortCircuit.key, JSON.stringify({ ...retryShortCircuit.data, used: false }), { ex: 3600 }).catch(() => {});
      console.log(`Retry credit ${retryToken} re-enabled after second failure`);
    } else if (redis) {
      // Fresh payment, first failure → issue brand-new retry credit
      retryToken = createHmac("sha256", String(Date.now())).update(String(Math.random())).digest("hex").slice(0, 32);
      const creditData = {
        amount: Number(totalPrice),
        model: resolvedModel,
        wallet: reqWallet || (payment && payment.payer) || null,
        timestamp: Date.now(),
        used: false,
      };
      await redis.set(`pixelpay:credit:${retryToken}`, JSON.stringify(creditData), { ex: 3600 }).catch(() => {});
      console.log(`Retry credit issued: ${retryToken} for ${totalPrice} (${resolvedModel})`);
    } else {
      console.warn("No Redis — cannot issue retry credit; user must request manual refund.");
    }
    res.status(502).json({
      type: "https://paymentauth.org/problems/upstream-error",
      title: "Upstream Error",
      status: 502,
      detail: retryToken
        ? "Image generation failed. You have a retry credit — use the retry_token to try again without paying."
        : "Image generation failed and no retry credit could be issued. Please contact support with your payment receipt for a refund.",
      upstream_error: err && err.message ? err.message.slice(0, 300) : undefined,
      ...(retryToken ? { retry_token: retryToken } : {}),
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

const DEMO_LIMIT = 5; // per IP per day (competitive with other APIs)

async function getDemoCount(ip, today) {
  if (!redis) return 0;
  const key = `pixelpay:demo:${ip}:${today}`;
  const count = await redis.get(key);
  return count ? Number(count) : 0;
}
async function incDemoCount(ip, today) {
  if (!redis) return;
  const key = `pixelpay:demo:${ip}:${today}`;
  await redis.incr(key);
  await redis.expire(key, 86400); // expire after 24h
}

app.post("/api/demo", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const today = new Date().toISOString().slice(0, 10);

  // Rate limit (Redis-backed)
  try {
    const count = await getDemoCount(ip, today);
    if (count >= DEMO_LIMIT) {
      return res.status(429).json({
        detail: `Demo limit reached (${DEMO_LIMIT}/day). Connect a wallet for unlimited access.`,
      });
    }
  } catch (rlErr) {
    console.error("Demo rate limit check failed:", rlErr.message);
    // Allow request if rate limiting fails (fail-open)
  }

  const { prompt, model, image_size, image_urls, style, enhance, negative_prompt, seed, private: isPrivate, wallet: reqWallet } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.length > 10000) {
    return res.status(400).json({ detail: "A 'prompt' string is required (max 10000 chars)." });
  }

  try {
    const usedModel = (!model || model === "auto") ? autoSelectModel(prompt) : (model || DEFAULT_MODEL);

    // Validate model exists
    const modelInfo = BASE_PRICING[usedModel];
    if (!modelInfo) {
      return res.status(400).json({ detail: `Model '${usedModel}' is not supported. Use: auto, ${Object.keys(BASE_PRICING).join(", ")}` });
    }

    // Block premium models from free demo
    if (modelInfo.premium) {
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

    // Block video/edit/transform models from free demo (too expensive)
    if (modelInfo.type === "video" || modelInfo.type === "edit" || modelInfo.type === "transform") {
      return res.status(403).json({ detail: `${usedModel} is not available in demo. Connect a wallet to use it.` });
    }

    let images, usedSeed = seed ?? null;
    if (cached) {
      images = cached.images;
      console.log(`Demo cache hit: ${cacheKey}`);
    } else {
      const falBody = buildFalBody(usedModel, { prompt: enhanced, image_size: size, num_images: 1, negative_prompt, seed, image_urls: refs });
      const falEndpoint = resolveFalEndpoint(usedModel, falBody);
      const falRes = await fetch(`${FAL_MPP_BASE}/${falEndpoint}`, {
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
      let firstImageUrl = null;
      for (const img of falImages) {
        if (img.url) {
          if (!firstImageUrl) firstImageUrl = img.url;
          try {
            const imgResp = await fetch(img.url);
            const buf = Buffer.from(await imgResp.arrayBuffer());
            images.push({ b64_json: buf.toString("base64"), content_type: img.content_type || "image/jpeg" });
          } catch { images.push(img); }
        } else { images.push(img); }
      }
      if (!hasRefs && images.length > 0) setCache(cacheKey, images, usedModel);

      // Save to gallery using original URL (before base64 conversion)
      // Default to private — only publish to public if explicitly opted in (private: false)
      if (firstImageUrl) {
        const demoPublishToPublic = isPrivate === false;
        gallerySave({ prompt, model: usedModel, style: style || null, image_url: firstImageUrl, wallet: reqWallet || null, timestamp: Date.now() }, demoPublishToPublic);
      }
    }

    // Only count non-cached as demo usage (cached = free)
    if (!cached) {
      await incDemoCount(ip, today);
    }

    if (images.length > 0 && !cached) {
      // PXP reward for generating
      if (payment.payer) mintPXP(payment.payer, "generate", "generate").catch(() => {});
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ detail: "Invalid wallet address." });
  if (prompt && prompt.length > 10000) return res.status(400).json({ detail: "Prompt too long (max 10000 chars)." });
  try {
    const entry = { prompt: (prompt || "").slice(0, 10000), model, style: style || null, image_url, seed: seed || null, wallet: wallet.toLowerCase(), timestamp: Date.now() };
    await redis.lpush(GALLERY_KEY, JSON.stringify(entry));
    await redis.ltrim(GALLERY_KEY, 0, MAX_GALLERY - 1);
    // No PXP reward for gallery publish — on-chain payment activity only
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ detail: "Invalid wallet address." });
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
  // Rate limit upscale (3 per IP per day) to prevent abuse
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const today = new Date().toISOString().slice(0, 10);
  const UPSCALE_LIMIT = 3;
  if (redis) {
    const upKey = `pixelpay:upscale:${ip}:${today}`;
    const upCount = await redis.get(upKey);
    if (upCount && Number(upCount) >= UPSCALE_LIMIT) {
      return res.status(429).json({ detail: `Upscale limit reached (${UPSCALE_LIMIT}/day). Connect a wallet for paid access.` });
    }
    await redis.incr(upKey);
    await redis.expire(upKey, 86400);
  }

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
// Image Edit endpoint: POST /v1/images/edit (MPP-protected)
// Uses FLUX Fill for inpainting/outpainting
// ---------------------------------------------------------------------------

app.post("/v1/images/edit", async (req, res) => {
  const { prompt, image_url, mask_url, image_size, wallet: reqWallet } = req.body || {};

  // Payment check FIRST (before body validation) so MPPscan probe gets 402
  const editModel = "fal-ai/flux-pro/v1/fill";
  const perImage = getPricing(editModel);
  const totalPrice = perImage.price;
  const desc = `Edit an image for ${perImage.usd} USDC (inpaint/outpaint)`;

  const payment = await handlePayment(req, res, { totalPrice, description: desc, path: "/v1/images/edit" });
  if (!payment.ok) return;

  if (!prompt || typeof prompt !== "string" || prompt.length > 10000) {
    return res.status(400).json({ detail: "A 'prompt' string is required (max 10000 chars)." });
  }
  if (!image_url) {
    return res.status(400).json({ detail: "An 'image_url' is required for edit." });
  }
  try { validateImageUrl(image_url); if (mask_url) validateImageUrl(mask_url); }
  catch (e) { return res.status(400).json({ detail: e.message }); }

  try {
    const refs = mask_url ? [image_url, mask_url] : [image_url];
    const falBody = buildFalBody(editModel, { prompt, image_size: image_size || "landscape_4_3", num_images: 1, image_urls: refs });
    const falRes = await fetch(`${FAL_MPP_BASE}/${editModel}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(falBody) });
    if (!falRes.ok) throw new Error(`fal.ai edit error: ${falRes.status}`);
    const result = await falRes.json();
    trackRequest();
    setPaymentReceipt(res, payment);
    if (payment.payer) mintPXP(payment.payer, "edit", "edit").catch(() => {});
    res.json({ images: result.images || [], prompt, model: editModel, timings: result.timings });
  } catch (err) {
    console.error("Edit error:", err.message);
    res.status(502).json({ detail: "Image editing failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Image Transform endpoint: POST /v1/images/transform (MPP-protected)
// Uses FLUX Kontext for style transfer / remix
// ---------------------------------------------------------------------------

app.post("/v1/images/transform", async (req, res) => {
  const { prompt, image_url, image_size, num_images, negative_prompt, seed, wallet: reqWallet } = req.body || {};

  // Payment check FIRST so MPPscan probe gets 402
  const transformModel = "fal-ai/flux-kontext/text-to-image";
  const count = Math.min(Math.max(num_images || 1, 1), 4);
  const perImage = getPricing(transformModel);
  const totalPrice = String(Math.round(Number(perImage.price) * count));
  const desc = `Transform image for ${(Number(totalPrice) / 1_000_000).toFixed(2)} USDC (style remix)`;

  const payment = await handlePayment(req, res, { totalPrice, description: desc, path: "/v1/images/transform" });
  if (!payment.ok) return;

  if (!prompt || typeof prompt !== "string" || prompt.length > 10000) {
    return res.status(400).json({ detail: "A 'prompt' string is required (max 10000 chars)." });
  }
  if (image_url) {
    try { validateImageUrl(image_url); } catch (e) { return res.status(400).json({ detail: e.message }); }
  }

  try {
    const refs = image_url ? [image_url] : [];
    const falBody = buildFalBody(transformModel, { prompt, image_size: image_size || "landscape_4_3", num_images: count, negative_prompt, seed, image_urls: refs });
    const falRes = await fetch(`${FAL_MPP_BASE}/${transformModel}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(falBody) });
    if (!falRes.ok) throw new Error(`fal.ai transform error: ${falRes.status}`);
    const result = await falRes.json();
    trackRequest();
    setPaymentReceipt(res, payment);
    if (payment.payer) mintPXP(payment.payer, "transform", "transform").catch(() => {});
    res.json({ images: result.images || [], prompt, model: transformModel, timings: result.timings });
  } catch (err) {
    console.error("Transform error:", err.message);
    res.status(502).json({ detail: "Image transform failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Video Generate endpoint: POST /v1/videos/generate (MPP + x402)
// Uses Seedance 1.0 Pro Fast for video generation
// ---------------------------------------------------------------------------

app.post("/v1/videos/generate", async (req, res) => {
  const { prompt, image_url, seed, wallet: reqWallet } = req.body || {};

  // Payment check FIRST so MPPscan probe gets 402
  const videoModel = "fal-ai/bytedance/seedance/v1/pro/fast/text-to-video";
  const perImage = getPricing(videoModel);
  const totalPrice = perImage.price;
  const desc = `Generate a 5s video for ${perImage.usd} USDC`;

  const payment = await handlePayment(req, res, { totalPrice, description: desc, path: "/v1/videos/generate" });
  if (!payment.ok) return;

  if (!prompt || typeof prompt !== "string" || prompt.length > 10000) {
    return res.status(400).json({ detail: "A 'prompt' string is required (max 10000 chars)." });
  }
  if (image_url) {
    try { validateImageUrl(image_url); } catch (e) { return res.status(400).json({ detail: e.message }); }
  }

  try {
    const refs = image_url ? [image_url] : [];
    const falBody = buildFalBody(videoModel, { prompt, image_urls: refs, seed });
    const falRes = await fetch(`${FAL_MPP_BASE}/${videoModel}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(falBody) });
    if (!falRes.ok) throw new Error(`fal.ai video error: ${falRes.status}`);
    const result = await falRes.json();
    trackRequest();
    setPaymentReceipt(res, payment);
    if (payment.payer) mintPXP(payment.payer, "video", "video").catch(() => {});
    const videoUrl = result.video?.url || null;
    res.json({ video: videoUrl ? { url: videoUrl } : null, prompt, model: videoModel, timings: result.timings, seed: result.seed ?? seed ?? null });
  } catch (err) {
    console.error("Video error:", err.message);
    res.status(502).json({ detail: "Video generation failed. Please retry." });
  }
});

// ---------------------------------------------------------------------------
// Generation History: POST /v1/history/save, GET /v1/history/:wallet
// ---------------------------------------------------------------------------
const HISTORY_MAX = 100;

app.post("/v1/history/save", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "History unavailable (Redis not configured)." });
  const { wallet, prompt, model, style, seed, image_url } = req.body || {};
  if (!wallet || !prompt) return res.status(400).json({ detail: "wallet and prompt are required." });
  // Don't store base64 images in Redis — only store URLs to save storage
  const entry = { prompt, model, style: style || null, seed: seed ?? null, image_url: image_url || null, timestamp: Date.now() };
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
  const { image_b64, image_url, content_type, metadata } = req.body || {};

  if (!image_b64 && !image_url) {
    return res.status(400).json({ detail: "Either image_b64 or image_url is required." });
  }

  try {
    let imageIpfsHash;
    let imgBuf;
    let imgContentType = content_type || "image/png";

    // Get image buffer from base64 or URL
    if (image_b64) {
      imgBuf = Buffer.from(image_b64, "base64");
    } else if (image_url) {
      // SSRF protection: only allow https URLs, block private/internal ranges
      try {
        const parsed = new URL(image_url);
        if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs allowed");
        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
            host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.") ||
            host.endsWith(".internal") || host.endsWith(".local") ||
            host === "169.254.169.254" || host.startsWith("169.254.")) {
          throw new Error("Internal URLs not allowed");
        }
      } catch (e) {
        return res.status(400).json({ detail: e.message || "Invalid image URL" });
      }
      const imgRes = await fetch(image_url);
      if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
      imgContentType = imgRes.headers.get("content-type") || imgContentType;
      imgBuf = Buffer.from(await imgRes.arrayBuffer());
    }

    // Upload image to Pinata
    if (imgBuf) {
      const ext = imgContentType.split("/")[1] || "png";
      const boundary = "----PinataFormBoundary" + Date.now();
      const fileName = `pixelpay-${Date.now()}.${ext}`;

      const bodyParts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${imgContentType}\r\n\r\n`,
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ detail: "Invalid wallet address." });
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) return res.status(400).json({ detail: "Valid tx_hash required." });

  // Verify tx_hash on-chain
  try {
    const receipt = await pxpPublicClient.getTransactionReceipt({ hash: tx_hash });
    if (!receipt || receipt.status === "reverted") {
      return res.status(400).json({ detail: "Transaction failed or not found on-chain." });
    }
    // Verify the sender matches the claimed wallet
    const tx = await pxpPublicClient.getTransaction({ hash: tx_hash });
    if (tx.from.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ detail: "Transaction sender does not match wallet." });
    }
  } catch (verifyErr) {
    return res.status(400).json({ detail: "Failed to verify transaction on-chain: " + verifyErr.message });
  }

  // Prevent duplicate mint records for same tokenId
  const existing = await redis.get(`pixelpay:nft:${tokenId}`);
  if (existing) return res.status(409).json({ detail: "Token already minted." });

  // Prevent same image from being minted twice
  if (image_url) {
    const imgHash = createHmac("sha256", "nft-dedup").update(image_url).digest("hex").slice(0, 32);
    const dupKey = `pixelpay:nft:img:${imgHash}`;
    const alreadyMinted = await redis.get(dupKey);
    if (alreadyMinted) {
      return res.status(409).json({ detail: "This image has already been minted as NFT.", existing_token: alreadyMinted });
    }
  }

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
    // Mark image as minted to prevent duplicates
    if (image_url) {
      const imgHash = createHmac("sha256", "nft-dedup").update(image_url).digest("hex").slice(0, 32);
      await redis.set(`pixelpay:nft:img:${imgHash}`, String(tokenId));
    }
    // PXP reward for minting NFT
    mintPXP(wallet.toLowerCase(), "mint_nft", "mint_nft").catch(() => {});
    res.json({ ok: true, nft: entry });
  } catch (err) {
    console.error("NFT mint record error:", err.message);
    res.status(500).json({ detail: "Failed to record mint." });
  }
});

// Get all active listings (MUST be before /:tokenId to avoid route conflict)
app.get("/v1/nft/listings", async (req, res) => {
  if (!redis) return res.json({ listings: [], total: 0 });
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const total = await redis.llen("pixelpay:nft:listings");
    const ids = await redis.lrange("pixelpay:nft:listings", offset, offset + limit - 1);
    const listings = [];
    for (const id of ids) {
      const ld = await redis.get(`pixelpay:nft:listing:${id}`);
      if (!ld) continue;
      const listing = typeof ld === "string" ? JSON.parse(ld) : ld;
      const nd = await redis.get(`pixelpay:nft:${id}`);
      if (!nd) continue;
      const nft = typeof nd === "string" ? JSON.parse(nd) : nd;
      listings.push({ ...listing, nft });
    }
    res.json({ listings, total, limit, offset });
  } catch (err) {
    res.json({ listings: [], total: 0 });
  }
});

// Recent activity (MUST be before /:tokenId)
app.get("/v1/nft/activity", async (req, res) => {
  if (!redis) return res.json({ activity: [], total: 0 });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const total = await redis.llen("pixelpay:nft:sales");
    const sales = await redis.lrange("pixelpay:nft:sales", offset, offset + limit - 1);
    const parsed = sales.map(s => typeof s === "string" ? JSON.parse(s) : s);
    res.json({ sales: parsed, activity: parsed, total, limit, offset });
  } catch (err) {
    res.json({ activity: [], total: 0 });
  }
});

// Get all NFTs by owner (MUST be before /:tokenId)
app.get("/v1/nft/by-owner/:wallet", async (req, res) => {
  if (!redis) return res.json({ nfts: [], total: 0 });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const total = await redis.llen(`pixelpay:nft:by_owner:${req.params.wallet.toLowerCase()}`);
    const ids = await redis.lrange(`pixelpay:nft:by_owner:${req.params.wallet.toLowerCase()}`, offset, offset + limit - 1);
    const nfts = [];
    for (const id of ids) {
      const data = await redis.get(`pixelpay:nft:${id}`);
      if (data) nfts.push(typeof data === "string" ? JSON.parse(data) : data);
    }
    res.json({ nfts, total, limit, offset });
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

// NFT stats (MUST be before /:tokenId)
app.get("/v1/nft/stats", async (_req, res) => {
  if (!redis) return res.json({ minted: 0 });
  try {
    const count = await redis.get("pixelpay:nft:counter");
    res.json({ minted: Number(count) || 0 });
  } catch(_) { res.json({ minted: 0 }); }
});

// Get NFT by tokenId (dynamic route MUST be after ALL static routes)
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) return res.status(400).json({ detail: "Invalid seller address." });
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) return res.status(400).json({ detail: "Invalid buyer address." });
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) return res.status(400).json({ detail: "Invalid tx_hash." });

  // Acquire lock to prevent double-buy race condition
  const lockKey = `pixelpay:nft:buying:${tokenId}`;
  const locked = await redis.set(lockKey, "1", { ex: 60, nx: true });
  if (!locked) return res.status(409).json({ detail: "Purchase already in progress for this NFT." });

  try {
    // Verify listing exists
    const ld = await redis.get(`pixelpay:nft:listing:${tokenId}`);
    if (!ld) return res.status(404).json({ detail: "Listing not found." });
    const listing = typeof ld === "string" ? JSON.parse(ld) : ld;

    // Prevent self-buy
    if (listing.seller === buyer.toLowerCase()) {
      return res.status(400).json({ detail: "Cannot buy your own listing." });
    }

    // Verify on-chain transaction actually succeeded
    try {
      const txReceipt = await pxpPublicClient.getTransactionReceipt({ hash: tx_hash });
      if (!txReceipt || txReceipt.status !== "success") {
        return res.status(400).json({ detail: "Transaction not confirmed on-chain." });
      }
    } catch (verifyErr) {
      return res.status(400).json({ detail: "Could not verify transaction: " + verifyErr.message });
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
    await redis.ltrim("pixelpay:nft:sales", 0, 499);

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
    // PXP reward for seller (sale bonus)
    if (listing?.seller) {
      const hasBonus = await redis.get(`pixelpay:nft:first_sale:${listing.seller}`);
      if (!hasBonus) {
        mintPXP(listing.seller, "mint_nft", "first_sale_bonus").catch(() => {});
        await redis.set(`pixelpay:nft:first_sale:${listing.seller}`, "1");
      }
    }
    res.json({ ok: true, sale });
  } catch (err) {
    res.status(500).json({ detail: "Failed to record sale." });
  } finally {
    await redis.del(lockKey);
  }
});

// Buy NFT with PXP tokens (20% discount, backend mediates on-chain)
app.post("/v1/nft/buy-pxp", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  if (!PXP_TOKEN || !MARKET_CONTRACT || !NFT_CONTRACT) return res.status(503).json({ detail: "PXP/marketplace/NFT not configured." });
  const { tokenId, buyer, pxp_tx_hash } = req.body || {};
  if (tokenId == null || !buyer || !pxp_tx_hash) return res.status(400).json({ detail: "tokenId, buyer, and pxp_tx_hash required." });
  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) return res.status(400).json({ detail: "Invalid buyer address." });

  // Acquire lock to prevent double-buy race condition
  const lockKey = `pixelpay:nft:buying:${tokenId}`;
  const locked = await redis.set(lockKey, "1", { ex: 60, nx: true });
  if (!locked) return res.status(409).json({ detail: "Purchase already in progress for this NFT." });

  try {
    const ld = await redis.get(`pixelpay:nft:listing:${tokenId}`);
    if (!ld) return res.status(404).json({ detail: "Listing not found." });
    const listing = typeof ld === "string" ? JSON.parse(ld) : ld;
    if (listing.seller === buyer.toLowerCase()) return res.status(400).json({ detail: "Cannot buy your own listing." });

    const usdcPrice = BigInt(listing.price);
    // PXP price: 20% discount, 100 PXP = $1. pxp = usdc * 0.8 * 100 / 1e6 * 1e18 = usdc * 80 * 1e12
    const pxpPrice = usdcPrice * 80n * 10n**12n;

    // Prevent PXP tx replay — each tx can only be used for one purchase
    if (redis) {
      const txUsed = await redis.get(`pixelpay:pxp:tx:used:${pxp_tx_hash}`).catch(() => null);
      if (txUsed) return res.status(400).json({ detail: "This PXP transaction has already been used for a purchase." });
    }

    // Verify PXP transfer actually happened on-chain with correct amount/recipient
    try {
      const txReceipt = await pxpPublicClient.getTransactionReceipt({ hash: pxp_tx_hash });
      if (!txReceipt || txReceipt.status !== "success") {
        return res.status(400).json({ detail: "PXP transfer not confirmed on-chain." });
      }
      // Verify Transfer event: from=buyer, to=treasury, amount>=pxpPrice
      const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
      const pxpLower = PXP_TOKEN.toLowerCase();
      const treasuryPadded = "0x" + walletAccount.address.slice(2).toLowerCase().padStart(64, "0");
      const buyerPadded = "0x" + buyer.toLowerCase().slice(2).padStart(64, "0");
      const matchingLog = txReceipt.logs.find(log =>
        log.address.toLowerCase() === pxpLower &&
        log.topics[0] === transferTopic &&
        log.topics[1]?.toLowerCase() === buyerPadded &&
        log.topics[2]?.toLowerCase() === treasuryPadded
      );
      if (!matchingLog) {
        return res.status(400).json({ detail: "PXP transfer not sent from buyer to treasury." });
      }
      const transferredAmount = BigInt(matchingLog.data);
      if (transferredAmount < pxpPrice) {
        return res.status(400).json({ detail: `Insufficient PXP transferred. Expected ${pxpPrice}, got ${transferredAmount}.` });
      }
    } catch (verifyErr) {
      return res.status(400).json({ detail: "Could not verify PXP transfer: " + verifyErr.message });
    }

    // Check backend USDC balance
    const usdcBal = await pxpPublicClient.readContract({
      address: USDC_TOKEN_ADDR, abi: USDC_ABI,
      functionName: "balanceOf", args: [walletAccount.address],
    });
    if (usdcBal < usdcPrice) return res.status(400).json({ detail: "Insufficient treasury USDC. Try regular USDC purchase." });

    // Approve USDC for marketplace if needed
    const allowance = await pxpPublicClient.readContract({
      address: USDC_TOKEN_ADDR, abi: USDC_ABI,
      functionName: "allowance", args: [walletAccount.address, MARKET_CONTRACT],
    });
    if (allowance < usdcPrice) {
      const appHash = await pxpWalletClient.writeContract({
        address: USDC_TOKEN_ADDR, abi: USDC_ABI,
        functionName: "approve", args: [MARKET_CONTRACT, usdcPrice * 10n],
        feeToken: PATHUSD,
      });
      await pxpPublicClient.waitForTransactionReceipt({ hash: appHash });
    }

    // Buy on marketplace (USDC → seller, NFT → backend wallet)
    const buyHash = await pxpWalletClient.writeContract({
      address: MARKET_CONTRACT, abi: MARKETPLACE_BUY_ABI,
      functionName: "buy", args: [BigInt(tokenId)],
      feeToken: PATHUSD,
    });
    await pxpPublicClient.waitForTransactionReceipt({ hash: buyHash });

    // Transfer NFT from backend wallet to buyer
    let nftHash;
    try {
      nftHash = await pxpWalletClient.writeContract({
        address: NFT_CONTRACT, abi: NFT_TRANSFER_ABI,
        functionName: "transferFrom", args: [walletAccount.address, buyer, BigInt(tokenId)],
        feeToken: PATHUSD,
      });
      await pxpPublicClient.waitForTransactionReceipt({ hash: nftHash });
    } catch (transferErr) {
      console.error(`PXP buy: NFT transfer failed after marketplace buy! tokenId=${tokenId} buyer=${buyer} buyTx=${buyHash}`);
      return res.status(500).json({ detail: "NFT purchased but transfer failed. Contact support with tx: " + buyHash });
    }

    // Update Redis (same as regular buy)
    const nd = await redis.get(`pixelpay:nft:${tokenId}`);
    const nft = nd ? (typeof nd === "string" ? JSON.parse(nd) : nd) : null;
    const sale = {
      tokenId: Number(tokenId), buyer: buyer.toLowerCase(), seller: listing.seller,
      price: listing.price, payment: "pxp", pxp_amount: pxpPrice.toString(),
      tx_hash: pxp_tx_hash, buy_tx_hash: buyHash, timestamp: Date.now(),
      image_url: nft?.image_url || null, name: nft?.prompt || null,
    };
    await redis.lpush("pixelpay:nft:sales", JSON.stringify(sale));
    await redis.ltrim("pixelpay:nft:sales", 0, 499);
    await redis.del(`pixelpay:nft:listing:${tokenId}`);
    await redis.lrem("pixelpay:nft:listings", 1, tokenId);
    if (nft) {
      const oldOwner = nft.wallet;
      nft.wallet = buyer.toLowerCase();
      await redis.set(`pixelpay:nft:${tokenId}`, JSON.stringify(nft));
      await redis.lpush(`pixelpay:nft:by_owner:${buyer.toLowerCase()}`, tokenId);
      if (oldOwner) await redis.lrem(`pixelpay:nft:by_owner:${oldOwner}`, 1, tokenId);
    }
    // PXP reward for seller (first sale bonus — only once)
    if (listing?.seller) {
      const hasBonus = await redis.get(`pixelpay:nft:first_sale:${listing.seller}`);
      if (!hasBonus) {
        mintPXP(listing.seller, "mint_nft", "first_sale_bonus").catch(() => {});
        await redis.set(`pixelpay:nft:first_sale:${listing.seller}`, "1");
      }
    }
    // Mark PXP tx as used (30 day TTL)
    if (redis) await redis.set(`pixelpay:pxp:tx:used:${pxp_tx_hash}`, "1", { ex: 30 * 24 * 3600 }).catch(() => {});
    console.log(`PXP buy: #${tokenId} buyer=${buyer.slice(0,8)}.. PXP=${Number(pxpPrice/10n**18n)} buy_tx=${buyHash.slice(0,10)}`);
    res.json({ ok: true, sale, pxp_price: pxpPrice.toString(), buy_tx: buyHash, nft_tx: nftHash });
  } catch (err) {
    console.error("PXP buy error:", err.message);
    res.status(500).json({ detail: "PXP purchase failed: " + err.message });
  } finally {
    await redis.del(lockKey);
  }
});

// Cancel a listing (requires seller query param for validation)
app.delete("/v1/nft/listing/:tokenId", async (req, res) => {
  if (!redis) return res.status(503).json({ detail: "Redis not configured." });
  const seller = req.query.seller;
  if (!seller || !/^0x[0-9a-fA-F]{40}$/.test(seller)) {
    return res.status(400).json({ detail: "Valid seller address required." });
  }
  try {
    const ld = await redis.get(`pixelpay:nft:listing:${req.params.tokenId}`);
    if (!ld) return res.status(404).json({ detail: "Listing not found." });
    const listing = typeof ld === "string" ? JSON.parse(ld) : ld;
    // Verify the caller is the seller
    if (listing.seller !== seller.toLowerCase()) {
      return res.status(403).json({ detail: "Only the seller can cancel." });
    }
    await redis.del(`pixelpay:nft:listing:${req.params.tokenId}`);
    await redis.lrem("pixelpay:nft:listings", 1, req.params.tokenId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ detail: "Failed to cancel listing." });
  }
});

// User profile: owned NFTs, created NFTs, transaction history
app.get("/v1/user/:wallet/profile", async (req, res) => {
  if (!redis) return res.json({ owned: [], created: [], history: [] });
  const wallet = req.params.wallet.toLowerCase();
  try {
    // Owned NFTs
    const ownedIds = await redis.lrange(`pixelpay:nft:by_owner:${wallet}`, 0, 99);
    const owned = [];
    for (const id of ownedIds) {
      const d = await redis.get(`pixelpay:nft:${id}`);
      if (d) owned.push(typeof d === "string" ? JSON.parse(d) : d);
    }
    // Created NFTs
    const createdIds = await redis.lrange(`pixelpay:nft:by_creator:${wallet}`, 0, 99);
    const created = [];
    for (const id of createdIds) {
      const d = await redis.get(`pixelpay:nft:${id}`);
      if (d) created.push(typeof d === "string" ? JSON.parse(d) : d);
    }
    // Transaction history (sales involving this wallet)
    const allSales = await redis.lrange("pixelpay:nft:sales", 0, 99);
    const history = allSales
      .map(s => typeof s === "string" ? JSON.parse(s) : s)
      .filter(s => s.buyer === wallet || s.seller === wallet)
      .map(s => ({ ...s, type: s.buyer === wallet ? "buy" : "sell" }));
    // Gallery count
    const galleryCount = await redis.llen(`pixelpay:user_gallery:${wallet}`);
    res.json({ owned, created, history, galleryCount, total_owned: owned.length, total_created: created.length });
  } catch (err) {
    res.status(500).json({ detail: "Failed to load profile." });
  }
});

// NFT contract info
app.get("/pixelpay/nft-config", (_req, res) => {
  res.json({
    nft_contract: process.env.NFT_CONTRACT_ADDRESS || NFT_CONTRACT,
    marketplace_contract: process.env.MARKETPLACE_CONTRACT_ADDRESS || MARKET_CONTRACT,
    pxp_token: process.env.PXP_TOKEN_ADDRESS || "",
    treasury_wallet: DERIVED_WALLET_ADDRESS,
    pxp_rate: 100, // 100 PXP = $1
    pxp_discount: 20, // 20% discount
    pxp_rewards: { generate: 5, edit: 3, transform: 2, video: 10, mint_nft: 5 },
    pxp_halving: { eras: 4, current_era: pxpRewardsCache.era, rate: `1/${pxpRewardsCache.denominator}` },
  });
});

// PXP balance for a wallet
app.get("/v1/pxp/balance/:wallet", async (req, res) => {
  if (!PXP_TOKEN) return res.json({ balance: "0", formatted: "0" });
  try {
    const bal = await pxpPublicClient.readContract({
      address: PXP_TOKEN, abi: PXP_ABI,
      functionName: "balanceOf", args: [req.params.wallet],
    });
    // String-based division to avoid Number precision loss for large balances
    const balStr = bal.toString();
    const whole = balStr.length > 18 ? balStr.slice(0, balStr.length - 18) : "0";
    const frac = balStr.padStart(18, "0").slice(-18).slice(0, 2);
    const formatted = `${whole}.${frac}`;
    res.json({ balance: bal.toString(), formatted });
  } catch (err) {
    res.json({ balance: "0", formatted: "0" });
  }
});

// PXP token info
app.get("/v1/pxp/info", async (_req, res) => {
  if (!PXP_TOKEN) return res.json({ address: "", totalSupply: "0" });
  try {
    const supply = await pxpPublicClient.readContract({
      address: PXP_TOKEN, abi: PXP_ABI, functionName: "totalSupply",
    });
    await refreshPxpEra();
    const fmtSupply = (() => { const s = supply.toString(); const w = s.length > 18 ? s.slice(0, s.length - 18) : "0"; const f = s.padStart(18, "0").slice(-18).slice(0, 2); return `${w}.${f}`; })();
    res.json({
      address: PXP_TOKEN, name: "PixelPay Token", symbol: "PXP",
      maxSupply: "21000000",
      rewardPool: "17850000",
      totalSupply: fmtSupply,
      halving: {
        era: pxpRewardsCache.era,
        rate: `1/${pxpRewardsCache.denominator}`,
        rewardsMinted: Number(pxpRewardsCache.totalMinted / 10n**18n),
        nextHalvingAt: Number(PXP_HALVING_INTERVAL * BigInt(pxpRewardsCache.era) / 10n**18n),
        exhausted: pxpRewardsCache.multiplier === 0n,
      },
      baseRates: { generate: 5, edit: 3, transform: 2, video: 10, mint_nft: 5 },
      currentRates: {
        generate: Number(getHalvedReward("generate") * 1000n / 10n**18n) / 1000,
        edit: Number(getHalvedReward("edit") * 1000n / 10n**18n) / 1000,
        transform: Number(getHalvedReward("transform") * 1000n / 10n**18n) / 1000,
        video: Number(getHalvedReward("video") * 1000n / 10n**18n) / 1000,
        mint_nft: Number(getHalvedReward("mint_nft") * 1000n / 10n**18n) / 1000,
      },
    });
  } catch (err) {
    res.json({ address: PXP_TOKEN, totalSupply: "0" });
  }
});

// Serve studio page
app.get("/studio", (_req, res) => {
  res.sendFile(join(ROOT, "public", "studio.html"));
});

// Serve marketplace page
app.get("/marketplace", (_req, res) => {
  res.sendFile(join(ROOT, "public", "marketplace.html"));
});

// Serve swap page
app.get("/swap", (_req, res) => {
  res.sendFile(join(ROOT, "public", "swap.html"));
});

// Serve profile page
app.get("/profile", (_req, res) => {
  res.sendFile(join(ROOT, "public", "profile.html"));
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
    features: ["prompt_enhancement", "smart_routing", "response_cache", "dynamic_pricing", "batch_discount", "on_chain_verification", "reference_images", "style_presets", "prompt_enhance", "public_gallery", "negative_prompt", "seed_control", "variations", "generation_history", "image_upscaler", "nft_minting", "nft_marketplace", "ipfs_upload", "image_edit", "image_transform", "video_generation", "multi_provider"],
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PixelPay listening on ${HOST}`);
  console.log(`  POST ${HOST}/v1/images/generate    (MPP — ${Object.keys(BASE_PRICING).filter(k => BASE_PRICING[k].type === "image").length} image models)`);
  console.log(`  POST ${HOST}/v1/images/edit         (MPP — inpaint/outpaint)`);
  console.log(`  POST ${HOST}/v1/images/transform    (MPP — style remix)`);
  console.log(`  POST ${HOST}/v1/videos/generate     (MPP — video generation)`);
  console.log(`  GET  ${HOST}/v1/prices`);
  console.log(`  GET  ${HOST}/v1/models`);
  console.log(`  GET  ${HOST}/openapi.json`);
  console.log(`  GET  ${HOST}/.well-known/mpp.json`);
});
