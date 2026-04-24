"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRegistrationPrefillToken = createRegistrationPrefillToken;
exports.verifyRegistrationPrefillToken = verifyRegistrationPrefillToken;
const node_crypto_1 = __importDefault(require("node:crypto"));
function getSecret() {
    const secret = process.env.WILLCALL_SMS_PREFILL_SECRET || "";
    if (!secret) {
        throw new Error("WILLCALL_SMS_PREFILL_SECRET is not configured");
    }
    return secret;
}
function fromBase64url(input) {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, "base64").toString("utf8");
}
function toBase64url(input) {
    return input
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}
function base64urlJson(value) {
    return toBase64url(Buffer.from(JSON.stringify(value), "utf8"));
}
function sign(data, secret) {
    return toBase64url(node_crypto_1.default.createHmac("sha256", secret).update(data).digest());
}
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length)
        return false;
    return node_crypto_1.default.timingSafeEqual(left, right);
}
function createRegistrationPrefillToken(input) {
    const secret = getSecret();
    const ttlHours = Math.max(1, Number(process.env.WILLCALL_SMS_PREFILL_TTL_HOURS || 24));
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
        p: "willcall-register-prefill",
        b: String(input.customerId || "").trim().toUpperCase(),
        z: String(input.billingZip || "").replace(/\D/g, "").slice(0, 5),
        i: String(input.inviteCode || "").trim(),
        e: input.email ? String(input.email).trim().toLowerCase() : null,
        o: input.orderNbr ? String(input.orderNbr).trim().toUpperCase() : null,
        exp: nowSec + ttlHours * 60 * 60,
    };
    const payloadB64 = base64urlJson(payload);
    const sig = sign(payloadB64, secret);
    return `${payloadB64}.${sig}`;
}
function verifyRegistrationPrefillToken(token) {
    const [payloadB64, signature] = String(token || "").split(".");
    if (!payloadB64 || !signature) {
        throw new Error("Invalid token format");
    }
    const expected = sign(payloadB64, getSecret());
    if (!safeEqual(signature, expected)) {
        throw new Error("Invalid token signature");
    }
    const payload = JSON.parse(fromBase64url(payloadB64));
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
