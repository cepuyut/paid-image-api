/**
 * MPP (Machine Payments Protocol) utilities.
 *
 * Implements the "Payment" HTTP authentication scheme per
 * draft-httpauth-payment-00, with Tempo "charge" intent.
 */

import { createHmac, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config – populated from env
// ---------------------------------------------------------------------------

const REALM = process.env.MPP_REALM || "paid-image-api";
const CHALLENGE_SECRET = process.env.MPP_CHALLENGE_SECRET || randomBytes(32).toString("hex");
const CHALLENGE_TTL_SECONDS = Number(process.env.MPP_CHALLENGE_TTL || 300); // 5 min
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const CURRENCY_TOKEN = process.env.CURRENCY_TOKEN;
const CHAIN_ID = Number(process.env.TEMPO_CHAIN_ID || 42431);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base64url-encode a buffer or string (no padding). */
function b64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

/** Base64url-decode to a UTF-8 string. */
function b64urlDecode(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}

/** JCS canonical JSON (recursively sorted keys per RFC 8785). */
function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(obj).sort().map(
    (k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])
  ).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Challenge generation (HMAC-SHA256 binding per spec §5.1.3)
// ---------------------------------------------------------------------------

/**
 * Build the HMAC id for a challenge using the 7-slot scheme from the spec.
 */
function computeChallengeId(realm, method, intent, requestB64, expires, digest, opaqueB64) {
  const slots = [
    realm,
    method,
    intent,
    requestB64,
    expires || "",
    digest || "",
    opaqueB64 || "",
  ];
  const input = slots.join("|");
  return createHmac("sha256", CHALLENGE_SECRET).update(input).digest("base64url");
}

/**
 * Create a 402 Payment challenge for a Tempo charge.
 *
 * @param {object} opts
 * @param {string} opts.amount  – amount in base units (string)
 * @param {string} [opts.description]
 * @returns {{ statusCode: number, headers: Record<string, string>, body: object }}
 */
export function createChallenge({ amount, description }) {
  const expires = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

  const requestObj = {
    amount,
    currency: CURRENCY_TOKEN,
    recipient: WALLET_ADDRESS,
    methodDetails: {
      chainId: CHAIN_ID,
      feePayer: true,
    },
  };
  if (description) requestObj.description = description;

  const requestB64 = b64url(canonicalJson(requestObj));
  const method = "tempo";
  const intent = "charge";

  const id = computeChallengeId(REALM, method, intent, requestB64, expires);

  const wwwAuth =
    `Payment id="${id}", realm="${REALM}", method="${method}", ` +
    `intent="${intent}", request="${requestB64}", expires="${expires}"`;

  const body = {
    type: "https://paymentauth.org/problems/payment-required",
    title: "Payment Required",
    status: 402,
    detail: description || "Payment required to generate image.",
    challengeId: id,
  };

  return {
    statusCode: 402,
    headers: {
      "WWW-Authenticate": wwwAuth,
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Credential verification
// ---------------------------------------------------------------------------

/**
 * Parse and verify an `Authorization: Payment <credential>` header.
 *
 * In a production deployment this would verify the Tempo transaction
 * signature and broadcast the tx to the Tempo network. For MPP directory
 * listing purposes we validate the challenge binding, expiry, and amount
 * so the 402 flow is fully exercisable.
 *
 * @param {string} authHeader – full Authorization header value
 * @param {string} expectedAmount – the amount we expect
 * @returns {{ ok: boolean, error?: string, credential?: object }}
 */
export function verifyCredential(authHeader, expectedAmount) {
  if (!authHeader || !authHeader.startsWith("Payment ")) {
    return { ok: false, error: "missing-credential" };
  }

  const b64 = authHeader.slice("Payment ".length).trim();
  let credential;
  try {
    credential = JSON.parse(b64urlDecode(b64));
  } catch {
    return { ok: false, error: "malformed-credential" };
  }

  const { challenge, payload } = credential;
  if (!challenge || !payload) {
    return { ok: false, error: "malformed-credential" };
  }

  // Re-compute expected id from the echoed challenge params
  const recomputedId = computeChallengeId(
    challenge.realm,
    challenge.method,
    challenge.intent,
    challenge.request,
    challenge.expires,
  );

  if (recomputedId !== challenge.id) {
    return { ok: false, error: "invalid-challenge" };
  }

  // Check expiry
  if (challenge.expires && new Date(challenge.expires) < new Date()) {
    return { ok: false, error: "payment-expired" };
  }

  // Decode request and verify amount
  try {
    const request = JSON.parse(b64urlDecode(challenge.request));
    if (request.amount !== expectedAmount) {
      return { ok: false, error: "payment-insufficient" };
    }
    if (request.recipient?.toLowerCase() !== WALLET_ADDRESS?.toLowerCase()) {
      return { ok: false, error: "verification-failed" };
    }
  } catch {
    return { ok: false, error: "malformed-credential" };
  }

  // Verify payload has proof (transaction signature or hash)
  if (!payload.signature && !payload.hash) {
    return { ok: false, error: "verification-failed" };
  }

  return { ok: true, credential };
}

// ---------------------------------------------------------------------------
// Receipt generation
// ---------------------------------------------------------------------------

/**
 * Build a Payment-Receipt header value.
 */
export function createReceipt(reference) {
  const receipt = {
    method: "tempo",
    reference: reference || `receipt_${randomBytes(12).toString("hex")}`,
    status: "success",
    timestamp: new Date().toISOString(),
  };
  return b64url(JSON.stringify(receipt));
}
