// src/types.ts
var PixelPayError = class extends Error {
  status;
  detail;
  type;
  constructor(status, detail, type) {
    super(detail);
    this.name = "PixelPayError";
    this.status = status;
    this.detail = detail;
    this.type = type;
  }
};
var PaymentRequiredError = class extends PixelPayError {
  challenge;
  constructor(challenge) {
    super(402, challenge.detail, challenge.type);
    this.name = "PaymentRequiredError";
    this.challenge = challenge;
  }
};

// src/index.ts
var DEFAULT_BASE_URL = "https://pixelpayapi.com";
var DEFAULT_TIMEOUT = 12e4;
var PixelPay = class {
  baseUrl;
  protocol;
  wallet;
  _fetch;
  timeout;
  maxRetries;
  constructor(config = {}) {
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
  async request(method, path, body, authHeader) {
    const url = `${this.baseUrl}${path}`;
    const headers = {};
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
    let lastError = null;
    const attempts = 1 + this.maxRetries;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this._fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : void 0,
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.status === 402) {
          const challenge = await this.parse402(res);
          throw new PaymentRequiredError(challenge);
        }
        if (res.ok) {
          return await res.json();
        }
        const errBody = await res.json().catch(() => ({ detail: res.statusText }));
        throw new PixelPayError(
          res.status,
          errBody.detail || errBody.message || res.statusText,
          errBody.type
        );
      } catch (err) {
        lastError = err;
        if (err instanceof PixelPayError) throw err;
        if (attempt < attempts - 1) continue;
      }
    }
    clearTimeout(timer);
    throw lastError || new Error("Request failed");
  }
  async parse402(res) {
    const body = await res.json().catch(() => ({}));
    return {
      status: 402,
      type: body.type || "",
      title: body.title || "Payment Required",
      detail: body.detail || "Payment is required to access this resource.",
      amount: body.amount || "",
      currency: body.currency || "USDC",
      mppChallenge: res.headers.get("WWW-Authenticate") || void 0,
      x402Challenge: res.headers.get("PAYMENT-REQUIRED") || void 0
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
  async generate(params, auth) {
    const body = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request("POST", "/v1/images/generate", body, auth);
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
  async edit(params, auth) {
    const body = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request("POST", "/v1/images/edit", body, auth);
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
  async transform(params, auth) {
    const body = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request("POST", "/v1/images/transform", body, auth);
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
  async video(params, auth) {
    const body = { ...params };
    if (this.wallet) body.wallet = this.wallet;
    return this.request("POST", "/v1/videos/generate", body, auth);
  }
  // -------------------------------------------------------------------------
  // Free Endpoints (no payment required)
  // -------------------------------------------------------------------------
  /** List all available models with pricing and capabilities. */
  async models() {
    return this.request("GET", "/v1/models");
  }
  /** Get current pricing for all models. */
  async prices() {
    return this.request("GET", "/v1/prices");
  }
  /** List available style presets. */
  async styles() {
    return this.request("GET", "/v1/styles");
  }
  /** Validate a prompt before paying. */
  async validate(prompt) {
    return this.request("POST", "/v1/validate", { prompt });
  }
  /** Upscale an image 2x. */
  async upscale(imageUrl) {
    return this.request("POST", "/v1/images/upscale", { image_url: imageUrl });
  }
  /** Get public gallery. */
  async gallery(page) {
    const q = page ? `?page=${page}` : "";
    return this.request("GET", `/v1/gallery${q}`);
  }
  /** Health check. */
  async health() {
    return this.request("GET", "/health");
  }
};
var index_default = PixelPay;
export {
  PaymentRequiredError,
  PixelPay,
  PixelPayError,
  index_default as default
};
