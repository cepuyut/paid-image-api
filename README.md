# Paid Image API

AI image generation API powered by [fal.ai](https://fal.ai), monetized via [MPP](https://mpp.dev) (Machine Payments Protocol).

No API keys needed — agents pay per request using the Tempo blockchain.

## Quick Start

```bash
cp .env.example .env
# Edit .env and add your FAL_KEY and MPP_CHALLENGE_SECRET

npm install
npm start
```

## How It Works

1. An agent sends `POST /v1/images/generate` with a prompt
2. The server responds with `402 Payment Required` and a `WWW-Authenticate: Payment` challenge
3. The agent signs a Tempo transaction for 0.50 pathUSD and retries with `Authorization: Payment <credential>`
4. The server verifies the payment, calls fal.ai, and returns the generated image(s) with a `Payment-Receipt`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/images/generate` | Generate image (MPP-protected) |
| GET | `/openapi.json` | MPP service discovery |
| GET | `/llms.txt` | LLM-friendly documentation |
| GET | `/health` | Health check |

## MPP Configuration

| Parameter | Value |
|-----------|-------|
| Payment method | `tempo` |
| Intent | `charge` |
| Price | 500,000 base units (0.50 pathUSD) |
| Currency | `0x20c000000000000000000000b9537d11c60e8b50` |
| Wallet | `0x8009c928c37285dc7e6e0527c3ac36d7a930e4eb` |
| Chain ID | 42431 (Tempo mainnet) |

## MPP Directory

This service is ready for the [MPP Payments Directory](https://mpp.dev/services). The `/openapi.json` endpoint includes `x-service-info` and `x-payment-info` extensions per the MPP discovery spec.

To register, submit your deployed domain to the MPP directory — the crawler will pick up `GET /openapi.json` automatically.

## License

MIT
