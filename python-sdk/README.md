# pixelpay

Python SDK for PixelPay — AI image & video generation with automatic payment via MPP or x402.

## Install

```bash
pip install pixelpay
```

## Quick Start

```python
from pixelpay import PixelPay, PaymentRequiredError

pp = PixelPay()

# Free endpoints
models = pp.models()
print(f"{models['total']} models available")

prices = pp.prices()
for tier in prices["tiers"]:
    print(f"  {tier['model']}: ${tier['price_usd']}")

# Paid endpoint — raises PaymentRequiredError with challenge
try:
    result = pp.generate(prompt="a cat in space")
    print(result["images"][0]["url"])
except PaymentRequiredError as e:
    print(f"Pay {e.challenge.detail}")
    print(f"MPP: {e.challenge.mpp_challenge}")
    print(f"x402: {e.challenge.x402_challenge}")
```

## All Methods

| Method | Endpoint | Payment | Description |
|--------|----------|---------|-------------|
| `generate(prompt, ...)` | POST /v1/images/generate | Yes | Generate images ($0.029-$0.19) |
| `edit(prompt, image_url)` | POST /v1/images/edit | Yes | Inpaint/outpaint ($0.079) |
| `transform(prompt, ...)` | POST /v1/images/transform | Yes | Style transfer ($0.049) |
| `video(prompt, ...)` | POST /v1/videos/generate | Yes | 5s video ($0.35) |
| `models()` | GET /v1/models | No | List all models |
| `prices()` | GET /v1/prices | No | Current pricing |
| `styles()` | GET /v1/styles | No | Style presets |
| `validate(prompt)` | POST /v1/validate | No | Validate prompt |
| `upscale(image_url)` | POST /v1/images/upscale | No | Upscale 2x |
| `gallery(page)` | GET /v1/gallery | No | Public gallery |
| `health()` | GET /health | No | Health check |

## Configuration

```python
pp = PixelPay(
    base_url="https://pixelpayapi.com",  # default
    wallet="0x...",                       # for PXP rewards
    timeout=120,                          # seconds
)
```

## License

MIT
