# PixelPay

AI image generation API monetized via [MPP](https://mpp.dev) (Machine Payments Protocol). No API keys — just pay per request with USDC on Tempo blockchain.

**Live:** https://paid-image-api.onrender.com

## Pricing

| Model | Tier | Price |
|-------|------|-------|
| `fal-ai/flux/schnell` | Schnell (fast) | $0.03 |
| `fal-ai/stable-diffusion-v35-large` | SD3.5 | $0.04 |
| `fal-ai/flux/dev` | Dev (balanced) | $0.05 |
| `fal-ai/recraft-v3` | Recraft (SVG + raster) | $0.06 |
| `fal-ai/hidream-i1-full` | HiDream (high quality) | $0.08 |
| `fal-ai/ideogram/v3` | Ideogram (text-in-image) | $0.08 |
| `fal-ai/flux-pro/v1.1` | Pro (high quality) | $0.10 |

## How It Works

```
POST /v1/images/generate  →  402 "pay first"  →  transfer USDC  →  200 + image
```

1. Send `POST /v1/images/generate` with a prompt and model
2. Receive `402 Payment Required` with payment challenge (amount varies by model)
3. Sign a Tempo transaction for the required USDC
4. Retry with `Authorization: Payment <credential>`
5. Get your generated image(s) + `Payment-Receipt` header

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/images/generate` | Generate image (MPP-protected) |
| `POST` | `/api/demo` | Free demo (3/day, no wallet needed) |
| `GET` | `/v1/prices` | Current pricing tiers |
| `GET` | `/openapi.json` | MPP service discovery |
| `GET` | `/llms.txt` | LLM-friendly docs |
| `GET` | `/health` | Health check |

## Quick Start

```bash
cp .env.example .env
# Edit .env with your FAL_KEY
npm install
npm start
```

## Tech Stack

- **Server:** Express.js
- **Image backend:** fal.ai (7 models)
- **Payments:** MPP via Tempo blockchain (USDC)
- **Deploy:** Render

## MPP Directory

Listed on [MPPscan](https://www.mppscan.com). The `/openapi.json` includes `x-payment-info` and `x-discovery` extensions per the MPP spec.

## License

MIT
