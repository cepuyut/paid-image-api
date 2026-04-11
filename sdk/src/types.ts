// ---------------------------------------------------------------------------
// PixelPay SDK — Type Definitions
// ---------------------------------------------------------------------------

/** Supported image models */
export type ImageModel =
  | "fal-ai/flux/schnell"
  | "xai/grok-imagine-image"
  | "fal-ai/flux/dev"
  | "fal-ai/recraft-v3"
  | "fal-ai/gpt-image-1/text-to-image"
  | "fal-ai/hidream-i1-full"
  | "fal-ai/ideogram/v3"
  | "fal-ai/flux-pro/v1.1"
  | "fal-ai/nano-banana-2"
  | "fal-ai/nano-banana-pro"
  | "auto";

/** Edit model */
export type EditModel = "fal-ai/flux-pro/v1/fill";

/** Transform model */
export type TransformModel = "fal-ai/flux-kontext/text-to-image";

/** Video model */
export type VideoModel = "fal-ai/bytedance/seedance/v1/pro/fast/text-to-video";

/** Style presets */
export type StylePreset =
  | "anime" | "cinematic" | "vintage" | "noir" | "cyberpunk"
  | "watercolor" | "oil-painting" | "pixel-art" | "minimalist" | "pop-art";

/** Image size presets */
export type ImageSize =
  | "square_hd" | "square" | "landscape_4_3" | "landscape_16_9"
  | "portrait_4_3" | "portrait_16_9";

/** SDK configuration */
export interface PixelPayConfig {
  /** Base URL (default: https://pixelpayapi.com) */
  baseUrl?: string;
  /** Payment protocol preference: "mpp" or "x402" (default: "mpp") */
  protocol?: "mpp" | "x402";
  /** Wallet address for PXP rewards and gallery attribution */
  wallet?: string;
  /** Custom fetch implementation (default: globalThis.fetch) */
  fetch?: typeof fetch;
  /** Request timeout in ms (default: 120000) */
  timeout?: number;
  /** Max retries on transient errors (default: 1) */
  maxRetries?: number;
}

/** Image generation request */
export interface GenerateRequest {
  /** Text prompt describing the image */
  prompt: string;
  /** Model to use (default: fal-ai/flux/schnell) */
  model?: ImageModel;
  /** Output image size (default: landscape_4_3) */
  image_size?: ImageSize | string;
  /** Number of images 1-4 (default: 1) */
  num_images?: number;
  /** Style preset */
  style?: StylePreset;
  /** Auto-enhance prompt */
  enhance?: boolean;
  /** Things to exclude */
  negative_prompt?: string;
  /** Seed for reproducibility */
  seed?: number;
  /** Reference images for img2img */
  image_urls?: string[];
  /** Gallery privacy (default: true = private) */
  private?: boolean;
}

/** Image edit request */
export interface EditRequest {
  /** Edit instruction */
  prompt: string;
  /** Source image URL */
  image_url: string;
  /** Mask URL for targeted edits */
  mask_url?: string;
  /** Output image size */
  image_size?: ImageSize | string;
}

/** Image transform request */
export interface TransformRequest {
  /** Style/transform instruction */
  prompt: string;
  /** Image to transform */
  image_url?: string;
  /** Output image size */
  image_size?: ImageSize | string;
  /** Number of outputs 1-4 */
  num_images?: number;
}

/** Video generation request */
export interface VideoRequest {
  /** Motion/scene description */
  prompt: string;
  /** Starting frame image */
  image_url?: string;
  /** Seed for reproducibility */
  seed?: number;
}

/** Generated image */
export interface ImageOutput {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

/** Image generation response */
export interface GenerateResponse {
  images: ImageOutput[];
  prompt: string;
  enhanced_prompt?: string;
  model: string;
  timings?: Record<string, unknown>;
  seed?: number;
  gallery_id?: string;
  pxp_reward?: string;
}

/** Edit response */
export interface EditResponse {
  images: ImageOutput[];
  prompt: string;
  model: string;
}

/** Transform response */
export interface TransformResponse {
  images: ImageOutput[];
  prompt: string;
  model: string;
}

/** Video response */
export interface VideoResponse {
  video: { url: string } | null;
  prompt: string;
  model: string;
}

/** Model info from /v1/models */
export interface ModelInfo {
  id: string;
  name: string;
  type: "image" | "edit" | "transform" | "video";
  tier: string;
  price: string;
  price_usd: string;
  premium: boolean;
  capabilities?: string[];
}

/** Price info from /v1/prices */
export interface PriceInfo {
  model: string;
  tier: string;
  price: string;
  price_usd: string;
}

/** Payment challenge (402 response) */
export interface PaymentChallenge {
  status: 402;
  type: string;
  title: string;
  detail: string;
  amount: string;
  currency: string;
  /** Raw WWW-Authenticate header (MPP) */
  mppChallenge?: string;
  /** Raw PAYMENT-REQUIRED header (x402) */
  x402Challenge?: string;
}

/** Error from PixelPay API */
export class PixelPayError extends Error {
  status: number;
  detail: string;
  type?: string;

  constructor(status: number, detail: string, type?: string) {
    super(detail);
    this.name = "PixelPayError";
    this.status = status;
    this.detail = detail;
    this.type = type;
  }
}

/** Payment required — caller must handle payment */
export class PaymentRequiredError extends PixelPayError {
  challenge: PaymentChallenge;

  constructor(challenge: PaymentChallenge) {
    super(402, challenge.detail, challenge.type);
    this.name = "PaymentRequiredError";
    this.challenge = challenge;
  }
}
