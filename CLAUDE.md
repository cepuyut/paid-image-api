# PixelPay — Project Context

## What is PixelPay?
AI image & video generation API monetized via MPP (Machine Payments Protocol) on Tempo blockchain. Users pay per request with USDC — no API keys, no signup.

## Architecture
- **Runtime**: Node.js + Express (single file: `src/index.js`)
- **Frontend**: Static HTML (`public/index.html`, `gallery.html`, `marketplace.html`, `profile.html`, `swap.html`)
- **Payment**: MPP via mppx library (`src/mpp.js`) — 402 challenge/pay/receipt flow
- **AI Backend**: fal.ai via MPP proxy (`https://fal.mpp.tempo.xyz/{model}`)
- **Storage**: Upstash Redis (gallery, history, NFT registry, rate limits, retry credits)
- **NFT**: Pinata IPFS upload + on-chain mint/list/buy on Tempo (chain 4217)
- **Token**: PXP ERC-20 reward token (mint on generate/publish/NFT mint)
- **Deploy**: Render (Starter $7/month), auto-deploy on push to master

## Key Files
| File | Purpose |
|---|---|
| `src/index.js` | Main backend — ALL endpoints (~1950 lines) |
| `src/mpp.js` | MPP challenge/verify/receipt helpers |
| `public/index.html` | Landing page + generate UI |
| `public/gallery.html` | Public/personal gallery |
| `public/marketplace.html` | NFT marketplace |
| `openapi.json` | MPPscan discovery spec |
| `llms.txt` | LLM-readable API docs |
| `agents.txt` | Agent instructions |

## Current Models (13 total, 4 endpoint types)
### Image Generation (POST /v1/images/generate)
| Model | Price | Tier |
|---|---|---|
| fal-ai/flux/schnell | $0.029 | schnell (DEFAULT) |
| xai/grok-imagine-image | $0.039 | grok |
| fal-ai/flux/dev | $0.049 | dev |
| fal-ai/recraft-v3 | $0.059 | recraft |
| fal-ai/gpt-image-1/text-to-image | $0.069 | gpt-image |
| fal-ai/hidream-i1-full | $0.079 | hidream |
| fal-ai/ideogram/v3 | $0.079 | ideogram |
| fal-ai/flux-pro/v1.1 | $0.099 | pro |
| fal-ai/nano-banana-2 | $0.14 | premium |
| fal-ai/nano-banana-pro | $0.19 | premium |

### Other Endpoints
| Endpoint | Model | Price |
|---|---|---|
| POST /v1/images/edit | fal-ai/flux-pro/v1/fill | $0.079 |
| POST /v1/images/transform | fal-ai/flux-kontext/text-to-image | $0.049 |
| POST /v1/videos/generate | fal-ai/bytedance/seedance/v1/pro/fast/text-to-video | $0.35 |

## Key Design Decisions
- `buildFalBody()` mapper handles model-specific API params (GPT-Image uses pixel sizes, Grok uses aspect_ratio)
- Images default to PRIVATE (must explicitly set `private: false` for public gallery)
- Paid endpoint cache DISABLED (users pay for fresh generations)
- NFT dedup via HMAC hash of image_url in Redis
- Retry credit system for failed paid generations (1hr TTL, X-PixelPay-Retry header)
- SSRF protection on all image_url inputs (HTTPS only, block internal ranges)
- Demo rate limit: 1/day per IP, fail-open
- Video/edit/transform models blocked from free demo

## Key Files
| File | Purpose |
|---|---|
| `src/x402.js` | x402 protocol module (Base USDC, facilitator) |

## Completed Phases
1. **Phase 1-4**: Core API, NFT marketplace, PXP token, gallery
2. **Phase 5**: Agent legibility (MPPscan, llms.txt, agents.txt, well-known)
3. **Phase 6**: Multi-Model Expansion (GPT-Image, Grok, edit, transform, video)
4. **Phase 7**: x402 Dual Protocol (Base USDC alongside MPP, reusable handlePayment())
5. **Phase 8**: SDK + MCP (TypeScript SDK `sdk/`, MCP server `mcp/`)

## Development Rules
- **ZERO BUGS** — user is very frustrated about repeated errors. Test thoroughly.
- Always use `rtk` prefix for commands
- Push to master triggers auto-deploy on Render
- Hard refresh (Ctrl+Shift+R) after deploy to clear browser cache
- Wallet address derived from WALLET_PRIVATE_KEY at startup
- MPP realm must be `pixelpayapi.com`
