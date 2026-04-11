// ---------------------------------------------------------------------------
// x402 Protocol Support — dual-protocol alongside MPP
// Enables agents on Base (Coinbase ecosystem) to pay via USDC on Base
// ---------------------------------------------------------------------------

import { HTTPFacilitatorClient, x402HTTPResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

// Base Mainnet USDC
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_CHAIN_ID = "eip155:8453";

// Coinbase CDP facilitator (production)
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";

// Wallet address to receive x402 payments (same treasury as MPP)
const PAY_TO = process.env.WALLET_ADDRESS || "";

let facilitator = null;
let resourceServer = null;

export function initX402() {
  if (!PAY_TO) {
    console.warn("x402: WALLET_ADDRESS not set — x402 disabled");
    return false;
  }
  try {
    facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
    resourceServer = new x402HTTPResourceServer(facilitator);
    resourceServer.register(BASE_CHAIN_ID, new ExactEvmScheme());
    console.log(`x402 initialized — facilitator: ${FACILITATOR_URL}, payTo: ${PAY_TO.slice(0, 10)}...`);
    return true;
  } catch (err) {
    console.error("x402 init error:", err.message);
    return false;
  }
}

// Detect which payment protocol the client is using
export function detectProtocol(req) {
  // x402 v2: client sends PAYMENT-SIGNATURE header
  const paymentSig = req.get("payment-signature") || req.get("PAYMENT-SIGNATURE");
  if (paymentSig) return "x402";

  // MPP: client sends Authorization: Payment <credential>
  const auth = req.get("Authorization");
  if (auth && auth.startsWith("Payment ")) return "mpp";

  return null;
}

// Build x402 PAYMENT-REQUIRED header value (base64-encoded JSON)
export function buildX402Challenge(priceUsdcBaseUnits, description, path) {
  if (!PAY_TO) return null;

  const requirements = {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: BASE_CHAIN_ID,
      maxAmountRequired: String(priceUsdcBaseUnits),
      asset: BASE_USDC,
      payTo: PAY_TO,
      resource: path || "/v1/images/generate",
      description: description || "PixelPay image generation",
      mimeType: "application/json",
    }],
  };

  return Buffer.from(JSON.stringify(requirements)).toString("base64");
}

// Verify x402 payment via facilitator
export async function verifyX402Payment(req, priceUsdcBaseUnits, path) {
  if (!facilitator || !resourceServer) {
    return { ok: false, error: "x402-not-configured" };
  }

  const paymentSig = req.get("payment-signature") || req.get("PAYMENT-SIGNATURE");
  if (!paymentSig) {
    return { ok: false, error: "missing-payment-signature" };
  }

  try {
    const payload = JSON.parse(Buffer.from(paymentSig, "base64").toString("utf8"));

    // Build route config matching what the payment was for
    const routeConfig = {
      accepts: [{
        scheme: "exact",
        network: BASE_CHAIN_ID,
        maxAmountRequired: String(priceUsdcBaseUnits),
        asset: BASE_USDC,
        payTo: PAY_TO,
        resource: path || "/v1/images/generate",
        description: "PixelPay generation",
        mimeType: "application/json",
      }],
    };

    // Verify signature cryptographically (fast, no on-chain call)
    const verifyResult = await resourceServer.verifyPayment(payload, routeConfig);
    if (!verifyResult || !verifyResult.valid) {
      return { ok: false, error: "payment-invalid" };
    }

    // Settle payment on-chain via facilitator
    const settleResult = await resourceServer.settlePayment(payload, routeConfig);
    if (!settleResult || !settleResult.success) {
      return { ok: false, error: "settlement-failed" };
    }

    console.log(`x402 payment settled: tx=${settleResult.transaction?.slice(0, 12)}... payer=${settleResult.payer?.slice(0, 10)}...`);

    return {
      ok: true,
      txHash: settleResult.transaction,
      payer: settleResult.payer,
      network: settleResult.network,
    };
  } catch (err) {
    console.error("x402 verify error:", err.message);
    return { ok: false, error: "verification-error" };
  }
}

// Build x402 PAYMENT-RESPONSE header for successful payment
export function buildX402Receipt(txHash, network) {
  if (!txHash) return null;
  const receipt = {
    x402Version: 2,
    success: true,
    transaction: txHash,
    network: network || BASE_CHAIN_ID,
  };
  return Buffer.from(JSON.stringify(receipt)).toString("base64");
}
