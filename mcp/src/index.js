#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PixelPay MCP Server — AI image & video generation as LLM agent tools
// ---------------------------------------------------------------------------
// Usage:
//   npx @pixelpay/mcp                     # stdio transport (default)
//   PIXELPAY_BASE_URL=https://pixelpayapi.com npx @pixelpay/mcp
//
// Claude Desktop config (~/.claude/claude_desktop_config.json):
//   { "mcpServers": { "pixelpay": { "command": "npx", "args": ["@pixelpay/mcp"] } } }
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.PIXELPAY_BASE_URL || "https://pixelpayapi.com";

async function apiCall(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  return { status: res.status, data: await res.json().catch(() => ({})), headers: Object.fromEntries(res.headers) };
}

// ---------------------------------------------------------------------------
// Server Setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "pixelpay",
  version: "1.0.0",
  description: "AI image & video generation API. Pay-per-request via MPP/x402 with USDC.",
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "generate_image",
  "Generate an AI image from a text prompt. Returns image URL(s). Costs $0.029-$0.19 USDC depending on model. Without payment credentials, returns a 402 payment challenge.",
  {
    prompt: z.string().describe("Text describing the image to generate"),
    model: z.string().optional().describe("Model ID (default: fal-ai/flux/schnell). Options: fal-ai/flux/schnell ($0.029), xai/grok-imagine-image ($0.039), fal-ai/flux/dev ($0.049), fal-ai/recraft-v3 ($0.059), fal-ai/gpt-image-1/text-to-image ($0.069), fal-ai/hidream-i1-full ($0.079), fal-ai/ideogram/v3 ($0.079), fal-ai/flux-pro/v1.1 ($0.099)"),
    image_size: z.string().optional().describe("Size: landscape_4_3, square_hd, portrait_4_3, landscape_16_9, portrait_16_9"),
    num_images: z.number().min(1).max(4).optional().describe("Number of images to generate (1-4)"),
    style: z.string().optional().describe("Style preset: anime, cinematic, vintage, noir, cyberpunk, watercolor, oil-painting, pixel-art, minimalist, pop-art"),
    enhance: z.boolean().optional().describe("Auto-enhance prompt for better results"),
  },
  async ({ prompt, model, image_size, num_images, style, enhance }) => {
    const body = { prompt, model, image_size, num_images, style, enhance };
    const { status, data } = await apiCall("POST", "/v1/images/generate", body);

    if (status === 402) {
      return {
        content: [{
          type: "text",
          text: `Payment required: ${data.detail || "Payment needed"}\n\nThis endpoint requires USDC payment via MPP (Tempo blockchain) or x402 (Base). Amount: ${data.amount || "see challenge"} USDC.\n\nTo use PixelPay with automatic payment, configure mppx with a Tempo wallet.`,
        }],
      };
    }

    if (status !== 200) {
      return {
        content: [{ type: "text", text: `Error (${status}): ${data.detail || JSON.stringify(data)}` }],
        isError: true,
      };
    }

    const images = data.images || [];
    const parts = [];
    parts.push({
      type: "text",
      text: `Generated ${images.length} image(s) with ${data.model}:\n${images.map((img, i) => `${i + 1}. ${img.url}`).join("\n")}${data.enhanced_prompt ? `\n\nEnhanced prompt: ${data.enhanced_prompt}` : ""}`,
    });

    return { content: parts };
  }
);

server.tool(
  "edit_image",
  "Edit an existing image via inpainting/outpainting. Costs $0.079 USDC.",
  {
    prompt: z.string().describe("Edit instruction (e.g., 'replace the sky with a sunset')"),
    image_url: z.string().url().describe("URL of the source image to edit"),
    mask_url: z.string().url().optional().describe("URL of mask image for targeted edits (white = edit area)"),
    image_size: z.string().optional().describe("Output size"),
  },
  async ({ prompt, image_url, mask_url, image_size }) => {
    const { status, data } = await apiCall("POST", "/v1/images/edit", { prompt, image_url, mask_url, image_size });

    if (status === 402) {
      return { content: [{ type: "text", text: `Payment required ($0.079 USDC): ${data.detail}` }] };
    }
    if (status !== 200) {
      return { content: [{ type: "text", text: `Error (${status}): ${data.detail || JSON.stringify(data)}` }], isError: true };
    }

    const images = data.images || [];
    return {
      content: [{ type: "text", text: `Edited image:\n${images.map((img, i) => `${i + 1}. ${img.url}`).join("\n")}` }],
    };
  }
);

server.tool(
  "transform_image",
  "Transform/remix an image with style transfer. Costs $0.049 USDC.",
  {
    prompt: z.string().describe("Style/transform instruction"),
    image_url: z.string().url().optional().describe("Image to transform"),
    image_size: z.string().optional().describe("Output size"),
    num_images: z.number().min(1).max(4).optional().describe("Number of outputs"),
  },
  async ({ prompt, image_url, image_size, num_images }) => {
    const { status, data } = await apiCall("POST", "/v1/images/transform", { prompt, image_url, image_size, num_images });

    if (status === 402) {
      return { content: [{ type: "text", text: `Payment required ($0.049 USDC): ${data.detail}` }] };
    }
    if (status !== 200) {
      return { content: [{ type: "text", text: `Error (${status}): ${data.detail || JSON.stringify(data)}` }], isError: true };
    }

    const images = data.images || [];
    return {
      content: [{ type: "text", text: `Transformed image:\n${images.map((img, i) => `${i + 1}. ${img.url}`).join("\n")}` }],
    };
  }
);

server.tool(
  "generate_video",
  "Generate a 5-second video from a text prompt. Costs $0.35 USDC.",
  {
    prompt: z.string().describe("Motion/scene description for the video"),
    image_url: z.string().url().optional().describe("Starting frame image for better results"),
    seed: z.number().optional().describe("Seed for reproducibility"),
  },
  async ({ prompt, image_url, seed }) => {
    const { status, data } = await apiCall("POST", "/v1/videos/generate", { prompt, image_url, seed });

    if (status === 402) {
      return { content: [{ type: "text", text: `Payment required ($0.35 USDC): ${data.detail}` }] };
    }
    if (status !== 200) {
      return { content: [{ type: "text", text: `Error (${status}): ${data.detail || JSON.stringify(data)}` }], isError: true };
    }

    const videoUrl = data.video?.url || "No video URL returned";
    return {
      content: [{ type: "text", text: `Generated video: ${videoUrl}` }],
    };
  }
);

server.tool(
  "list_models",
  "List all available PixelPay models with pricing and capabilities. Free endpoint.",
  {},
  async () => {
    const { data } = await apiCall("GET", "/v1/models");
    const models = data.models || [];
    const lines = models.map(m =>
      `${m.id} (${m.type}) — $${m.price_usd} USDC${m.premium ? " [premium]" : ""}`
    );
    return {
      content: [{ type: "text", text: `Available models (${models.length}):\n${lines.join("\n")}\n\nDefault: ${data.default_model}` }],
    };
  }
);

server.tool(
  "get_prices",
  "Get current pricing for all PixelPay models. Free endpoint.",
  {},
  async () => {
    const { data } = await apiCall("GET", "/v1/prices");
    const tiers = data.tiers || [];
    const lines = tiers.map(t => `${t.model} — $${t.price_usd} USDC (${t.tier})`);
    return {
      content: [{ type: "text", text: `Pricing (${data.surge || "normal"} demand):\n${lines.join("\n")}` }],
    };
  }
);

server.tool(
  "validate_prompt",
  "Validate a prompt before paying for generation. Free endpoint.",
  {
    prompt: z.string().describe("Prompt to validate"),
  },
  async ({ prompt }) => {
    const { data } = await apiCall("POST", "/v1/validate", { prompt });
    return {
      content: [{ type: "text", text: `Valid: ${data.valid}\nSanitized: ${data.sanitized || prompt}` }],
    };
  }
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.resource(
  "pricing",
  "pixelpay://pricing",
  { description: "Current PixelPay pricing for all models", mimeType: "application/json" },
  async () => {
    const { data } = await apiCall("GET", "/v1/prices");
    return { contents: [{ uri: "pixelpay://pricing", text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  }
);

server.resource(
  "models",
  "pixelpay://models",
  { description: "Available PixelPay models and capabilities", mimeType: "application/json" },
  async () => {
    const { data } = await apiCall("GET", "/v1/models");
    return { contents: [{ uri: "pixelpay://models", text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
