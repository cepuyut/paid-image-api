# Paid Image API

AI image generation API monetized via [MPP](https://mpp.dev) (Machine Payments Protocol). No API keys — just pay per request with pathUSD on Tempo blockchain.

**Live:** https://paid-image-api-production.up.railway.app

## Pricing

| Model | Tier | Price |
|-------|------|-------|
| `fal-ai/flux/schnell` | Schnell (fast) | $0.03 |
| `fal-ai/flux/dev` | Dev (balanced) | $0.05 |
| `gemini-3-pro-image-preview` | Dev (balanced) | $0.05 |
| `fal-ai/flux-pro/v1.1` | Pro (high quality) | $0.10 |

## How It Works

```
POST /v1/images/generate  →  402 "pay first"  →  transfer pathUSD  →  200 + image
```

1. Send `POST /v1/images/generate` with a prompt and model
2. Receive `402 Payment Required` with payment challenge (amount varies by model)
3. Sign a Tempo transaction for the required pathUSD
4. Retry with `Authorization: Payment <credential>`
5. Get your generated image(s) + `Payment-Receipt` header

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/images/generate` | Generate image (MPP-protected) |
| `GET` | `/v1/prices` | Current pricing tiers |
| `GET` | `/openapi.json` | MPP service discovery |
| `GET` | `/llms.txt` | LLM-friendly docs |
| `GET` | `/health` | Health check |

## Quick Start

```bash
cp .env.example .env
# Edit .env with your keys
npm install
npm start
```

## Tech Stack

- **Server:** Express.js
- **Image backends:** Bluesminds (OpenAI-compatible) + fal.ai
- **Payments:** MPP via Tempo blockchain (pathUSD)
- **Deploy:** Railway

## MPP Directory

Listed on [MPPscan](https://www.mppscan.com). The `/openapi.json` includes `x-payment-info` and `x-discovery` extensions per the MPP spec.

## License

MIT
