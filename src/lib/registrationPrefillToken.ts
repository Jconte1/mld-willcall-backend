import crypto from "node:crypto";

type PrefillPayload = {
  p: "willcall-register-prefill";
  b: string;
  z: string;
  i: string;
  e?: string | null;
  o?: string | null;
  exp: number;
};

function getSecret() {
  const secret = process.env.WILLCALL_SMS_PREFILL_SECRET || "";
  if (!secret) {
    throw new Error("WILLCALL_SMS_PREFILL_SECRET is not configured");
  }
  return secret;
}

function fromBase64url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function toBase64url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sign(data: string, secret: string) {
  return toBase64url(crypto.createHmac("sha256", secret).update(data).digest());
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyRegistrationPrefillToken(token: string) {
  const [payloadB64, signature] = String(token || "").split(".");
  if (!payloadB64 || !signature) {
    throw new Error("Invalid token format");
  }

  const expected = sign(payloadB64, getSecret());
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(fromBase64url(payloadB64)) as PrefillPayload;
  if (payload.p !== "willcall-register-prefill") {
    throw new Error("Invalid token purpose");
  }
  if (!payload.b || !payload.z || !payload.i || !payload.exp) {
    throw new Error("Invalid token payload");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    throw new Error("Token expired");
  }

  return {
    baid: payload.b.trim().toUpperCase(),
    zip: payload.z.replace(/\D/g, "").slice(0, 5),
    inviteCode: payload.i.trim(),
    email: payload.e ? payload.e.trim().toLowerCase() : null,
    orderNbr: payload.o ? payload.o.trim().toUpperCase() : null,
  };
}

