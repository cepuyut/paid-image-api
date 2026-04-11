# @pixelpay/sdk

TypeScript/JavaScript SDK for PixelPay — AI image & video generation with automatic payment via MPP or x402.

## Install

```bash
npm install @pixelpay/sdk
```

## Quick Start

```typescript
import { PixelPay, PaymentRequiredError } from "@pixelpay/sdk";

const pp = new PixelPay();

// Free endpoints (no payment needed)
const { models } = await pp.models();
const { tiers } = await pp.prices();
const { status } = await pp.health();

// Paid endpoints — returns 402 with payment challenge
try {
  const result = await pp.generate({ prompt: "a cat in space" });
  console.log(result.images[0].url);
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    console.log("Pay:", err.challenge.amount, "USDC");
    console.log("MPP challenge:", err.challenge.mppChallenge);
    console.log("x402 challenge:", err.challenge.x402Challenge);
  }
}
```

## Auto-Payment with mppx

```typescript
import { PixelPay } from "@pixelpay/sdk";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

// Initialize MPP auto-payment (patches global fetch)
Mppx.create({ methods: [tempo({ account: privateKeyToAccount("0x...") })] });

const pp = new PixelPay({ wallet: "0xYourAddress" });

// Now generate() handles payment automatically
const { images } = await pp.generate({ prompt: "sunset over mountains" });
console.log(images[0].url); // Direct result, no 402
```

## All Methods

| Method | Endpoint | Payment | Description |
|--------|----------|---------|-------------|
| `generate(params)` | POST /v1/images/generate | Yes | Generate images ($0.029-$0.19) |
| `edit(params)` | POST /v1/images/edit | Yes | Inpaint/outpaint ($0.079) |
| `transform(params)` | POST /v1/images/transform | Yes | Style transfer ($0.049) |
| `video(params)` | POST /v1/videos/generate | Yes | 5s video ($0.35) |
| `models()` | GET /v1/models | No | List all models |
| `prices()` | GET /v1/prices | No | Current pricing |
| `styles()` | GET /v1/styles | No | Style presets |
| `validate(prompt)` | POST /v1/validate | No | Validate prompt |
| `upscale(url)` | POST /v1/images/upscale | No | Upscale 2x |
| `gallery(page?)` | GET /v1/gallery | No | Public gallery |
| `health()` | GET /health | No | Health check |

## Configuration

```typescript
const pp = new PixelPay({
  baseUrl: "https://pixelpayapi.com",  // default
  protocol: "mpp",                      // "mpp" or "x402"
  wallet: "0x...",                       // for PXP rewards
  timeout: 120000,                       // request timeout ms
  maxRetries: 1,                         // retry on network errors
});
```

## License

MIT
