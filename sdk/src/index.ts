// ---------------------------------------------------------------------------
// PixelPay SDK — AI Image & Video Generation with Automatic Payment
// ---------------------------------------------------------------------------
// Usage:
//   import { PixelPay } from "@pixelpay/sdk";
//   const pp = new PixelPay();                              // browsing mode
//   const pp = new PixelPay({ wallet: "0x..." });           // with rewards
//   const { images } = await pp.generate({ prompt: "cat" }); // returns 402 for payment
// ---------------------------------------------------------------------------

export * from "./types.js";

import type {
  PixelPayConfig,
  GenerateRequest,
  GenerateResponse,
  EditRequest,
  EditResponse,
  TransformRequest,
  TransformResponse,
  VideoRequest,
  VideoResponse,
  ModelInfo,
  PriceInfo,
  PaymentChallenge,
} from "./types.js";

import { PixelPayError, PaymentRequiredError } from "./types.js";

const DEFAULT_BASE_URL = "https://pixelpayapi.com";
const DEFAULT_TIMEOUT = 120_000;

export class PixelPay {
  private baseUrl: string;
  private protocol: "mpp" | "x402";
  private wallet?: string;
  private _fetch: typeof fetch;
  private timeout: number;
  private maxRetries: number;

  constructor(config: PixelPayConfig = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.protocol = config.protocol || "mpp";
    this.wallet = config.wallet;
    this._fetch = config.fetch || globalThis.fetch;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? 1;
  }

  // -------------------------------------------------------------------------
  // Core request helper
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    authHeader?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};

    if (body) headers["Content-Type"] = "application/json";
    if (authHeader) {
      if (this.protocol === "mpp") {
        headers["Authorization"] = authHeader;
      } else {
        headers["PAYMENT-SIGNATURE"] = authHeader;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let lastError: Error | null = null;
    const attempts = 1 + this.maxRetries;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this._fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        // 402 Payment Required — return structured challenge
        if (res.status === 402) {
          const challenge = await this.parse402(res);
          throw new PaymentRequiredError(challenge);
        }

        // Success
        if (res.ok) {
          return (await res.json()) as T;
        }

        // Client/server error
        const errBody = await res.json().catch(() => ({ detail: res.statusText }));
        throw new PixelPayError(
          res.status,
          errBody.detail || errBody.message || res.statusText,
          errBody.type,
        );
      } catch (err) {
        lastError = err as Error;
        // Don't retry 402 or 4xx
        if (err instanceof PixelPayError) throw err;
        // Retry on network errors
        if (attempt < attempts - 1) continue;
      }
    }

    clearTimeout(timer);
    throw lastError || new Error("Request failed");
  }

  private async parse402(res: Response): Promise<PaymentChallenge> {
    const body = await res.json().catch(() => ({}));
    return {
      status: 402,
      type: body.type || "",
      title: body.title || "Payment Required",
      detail: body.detail || "Payment is required to access this resource.",
      amount: body.amount || "",
      currency: body.currency || "USDC",
      mppChallenge: res.headers.get("WWW-Authenticate") || undefined,
      x402Challenge: res.headers.get("PAYMENT-REQUIRED") || undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Image Generation
  // -------------------------------------------------------------------------

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
  async generate(
    params: GenerateRequest,
    auth?: string,
  ): Promise<GenerateResponse> {
    const body: Record<string, unknown> = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request<GenerateResponse>("POST", "/v1/images/generate", body, auth);
  }

  // -------------------------------------------------------------------------
  // Image Edit
  // -------------------------------------------------------------------------

  /**
   * Edit an image via inpainting/outpainting.
   *
   * @example
   * const { images } = await pp.edit({
   *   prompt: "replace sky with sunset",
   *   image_url: "https://example.com/photo.jpg"
   * });
   */
  async edit(
    params: EditRequest,
    auth?: string,
  ): Promise<EditResponse> {
    const body: Record<string, unknown> = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request<EditResponse>("POST", "/v1/images/edit", body, auth);
  }

  // -------------------------------------------------------------------------
  // Image Transform
  // -------------------------------------------------------------------------

  /**
   * Transform/remix an image with style transfer.
   *
   * @example
   * const { images } = await pp.transform({
   *   prompt: "make it look like a watercolor painting",
   *   image_url: "https://example.com/photo.jpg"
   * });
   */
  async transform(
    params: TransformRequest,
    auth?: string,
  ): Promise<TransformResponse> {
    const body: Record<string, unknown> = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request<TransformResponse>("POST", "/v1/images/transform", body, auth);
  }

  // -------------------------------------------------------------------------
  // Video Generation
  // -------------------------------------------------------------------------

  /**
   * Generate a 5-second video from a text prompt.
   *
   * @example
   * const { video } = await pp.video({ prompt: "waves crashing on a beach" });
   * console.log(video?.url);
   */
  async video(
    params: VideoRequest,
    auth?: string,
  ): Promise<VideoResponse> {
    const body: Record<string, unknown> = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request<VideoResponse>("POST", "/v1/videos/generate", body, auth);
  }

  // -------------------------------------------------------------------------
  // Free Endpoints (no payment required)
  // -------------------------------------------------------------------------

  /** List all available models with pricing and capabilities. */
  async models(): Promise<{ models: ModelInfo[]; default_model: string; total: number }> {
    return this.request("GET", "/v1/models");
  }

  /** Get current pricing for all models. */
  async prices(): Promise<{ currency: string; tiers: PriceInfo[]; surge: string; demand_multiplier: number }> {
    return this.request("GET", "/v1/prices");
  }

  /** List available style presets. */
  async styles(): Promise<Record<string, string>[]> {
    return this.request<Record<string, string>[]>("GET", "/v1/styles");
  }

  /** Validate a prompt before paying. */
  async validate(prompt: string): Promise<{ valid: boolean; sanitized: string }> {
    return this.request("POST", "/v1/validate", { prompt });
  }

  /** Upscale an image 2x. */
  async upscale(imageUrl: string): Promise<{ image_url: string }> {
    return this.request("POST", "/v1/images/upscale", { image_url: imageUrl });
  }

  /** Get public gallery. */
  async gallery(page?: number): Promise<unknown[]> {
    const q = page ? `?page=${page}` : "";
    return this.request<unknown[]>("GET", `/v1/gallery${q}`);
  }

  /** Health check. */
  async health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("GET", "/health");
  }
}

// Default export for convenience
export default PixelPay;
