/** Supported image models */
type ImageModel = "fal-ai/flux/schnell" | "xai/grok-imagine-image" | "fal-ai/flux/dev" | "fal-ai/recraft-v3" | "fal-ai/gpt-image-1/text-to-image" | "fal-ai/hidream-i1-full" | "fal-ai/ideogram/v3" | "fal-ai/flux-pro/v1.1" | "fal-ai/nano-banana-2" | "fal-ai/nano-banana-pro" | "auto";
/** Edit model */
type EditModel = "fal-ai/flux-pro/v1/fill";
/** Transform model */
type TransformModel = "fal-ai/flux-kontext/text-to-image";
/** Video model */
type VideoModel = "fal-ai/bytedance/seedance/v1/pro/fast/text-to-video";
/** Style presets */
type StylePreset = "anime" | "cinematic" | "vintage" | "noir" | "cyberpunk" | "watercolor" | "oil-painting" | "pixel-art" | "minimalist" | "pop-art";
/** Image size presets */
type ImageSize = "square_hd" | "square" | "landscape_4_3" | "landscape_16_9" | "portrait_4_3" | "portrait_16_9";
/** SDK configuration */
interface PixelPayConfig {
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
interface GenerateRequest {
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
interface EditRequest {
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
interface TransformRequest {
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
interface VideoRequest {
    /** Motion/scene description */
    prompt: string;
    /** Starting frame image */
    image_url?: string;
    /** Seed for reproducibility */
    seed?: number;
}
/** Generated image */
interface ImageOutput {
    url: string;
    width?: number;
    height?: number;
    content_type?: string;
}
/** Image generation response */
interface GenerateResponse {
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
interface EditResponse {
    images: ImageOutput[];
    prompt: string;
    model: string;
}
/** Transform response */
interface TransformResponse {
    images: ImageOutput[];
    prompt: string;
    model: string;
}
/** Video response */
interface VideoResponse {
    video: {
        url: string;
    } | null;
    prompt: string;
    model: string;
}
/** Model info from /v1/models */
interface ModelInfo {
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
interface PriceInfo {
    model: string;
    tier: string;
    price: string;
    price_usd: string;
}
/** Payment challenge (402 response) */
interface PaymentChallenge {
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
declare class PixelPayError extends Error {
    status: number;
    detail: string;
    type?: string;
    constructor(status: number, detail: string, type?: string);
}
/** Payment required — caller must handle payment */
declare class PaymentRequiredError extends PixelPayError {
    challenge: PaymentChallenge;
    constructor(challenge: PaymentChallenge);
}

declare class PixelPay {
    private baseUrl;
    private protocol;
    private wallet?;
    private _fetch;
    private timeout;
    private maxRetries;
    constructor(config?: PixelPayConfig);
    private request;
    private parse402;
    /**
     * Generate images from a text prompt.
     *
     * Without payment credentials, throws PaymentRequiredError with challenge.
     * With mppx configured globally, payment is handled automatically.
     *
     * @example
     * const { images } = await pp.generate({ prompt: "a cat in space" });
     * console.log(images[0].url);
     */
    generate(params: GenerateRequest, auth?: string): Promise<GenerateResponse>;
    /**
     * Edit an image via inpainting/outpainting.
     *
     * @example
     * const { images } = await pp.edit({
     *   prompt: "replace sky with sunset",
     *   image_url: "https://example.com/photo.jpg"
     * });
     */
    edit(params: EditRequest, auth?: string): Promise<EditResponse>;
    /**
     * Transform/remix an image with style transfer.
     *
     * @example
     * const { images } = await pp.transform({
     *   prompt: "make it look like a watercolor painting",
     *   image_url: "https://example.com/photo.jpg"
     * });
     */
    transform(params: TransformRequest, auth?: string): Promise<TransformResponse>;
    /**
     * Generate a 5-second video from a text prompt.
     *
     * @example
     * const { video } = await pp.video({ prompt: "waves crashing on a beach" });
     * console.log(video?.url);
     */
    video(params: VideoRequest, auth?: string): Promise<VideoResponse>;
    /** List all available models with pricing and capabilities. */
    models(): Promise<{
        models: ModelInfo[];
        default_model: string;
        total: number;
    }>;
    /** Get current pricing for all models. */
    prices(): Promise<{
        currency: string;
        tiers: PriceInfo[];
        surge: string;
        demand_multiplier: number;
    }>;
    /** List available style presets. */
    styles(): Promise<Record<string, string>[]>;
    /** Validate a prompt before paying. */
    validate(prompt: string): Promise<{
        valid: boolean;
        sanitized: string;
    }>;
    /** Upscale an image 2x. */
    upscale(imageUrl: string): Promise<{
        image_url: string;
    }>;
    /** Get public gallery. */
    gallery(page?: number): Promise<unknown[]>;
    /** Health check. */
    health(): Promise<{
        status: string;
    }>;
}

export { type EditModel, type EditRequest, type EditResponse, type GenerateRequest, type GenerateResponse, type ImageModel, type ImageOutput, type ImageSize, type ModelInfo, type PaymentChallenge, PaymentRequiredError, PixelPay, type PixelPayConfig, PixelPayError, type PriceInfo, type StylePreset, type TransformModel, type TransformRequest, type TransformResponse, type VideoModel, type VideoRequest, type VideoResponse, PixelPay as default };
