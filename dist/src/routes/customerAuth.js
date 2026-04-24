"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.customerAuthRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const passwords_1 = require("../lib/passwords");
const verifyBaid_1 = require("../lib/acumatica/verifyBaid");
const loginThrottle_1 = require("../lib/loginThrottle");
const registrationPrefillToken_1 = require("../lib/registrationPrefillToken");
exports.customerAuthRouter = (0, express_1.Router)();
const REGISTER_REASON = {
    InvalidBody: "INVALID_REQUEST_BODY",
    PasswordTooShort: "PASSWORD_TOO_SHORT",
    PasswordNumberRequired: "PASSWORD_NUMBER_REQUIRED",
    PasswordSymbolRequired: "PASSWORD_SYMBOL_REQUIRED",
    EmailAlreadyExists: "EMAIL_ALREADY_EXISTS",
    DetailsNotConfirmed: "DETAILS_NOT_CONFIRMED",
    RegisterFailed: "REGISTER_FAILED",
};
const BAID_REGEX = /^BA\d{7}$/;
const REGISTER_BODY = zod_1.z.object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email(),
    phone: zod_1.z
        .string()
        .transform((v) => v.replace(/\D/g, ""))
        .refine((v) => v.length === 10, { message: "Enter a 10-digit phone number" }),
    baid: zod_1.z
        .string()
        .transform((v) => v.trim().toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    zip: zod_1.z
        .string()
        .transform((v) => v.replace(/\D/g, "").slice(0, 5))
        .refine((v) => /^\d{5}$/.test(v), { message: "ZIP must be 5 digits" }),
    inviteCode: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, ""))
        .refine((v) => v.length >= 6, { message: "Invite code is required" }),
    password: zod_1.z.string().min(1),
});
const VERIFY_BAID_BODY = zod_1.z.object({
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    zip: zod_1.z
        .string()
        .transform((v) => v.replace(/\D/g, "").slice(0, 5))
        .refine((v) => /^\d{5}$/.test(v), { message: "ZIP must be 5 digits" }),
});
const LOGIN_BODY = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1),
});
const REGISTER_PREFILL_BODY = zod_1.z.object({
    token: zod_1.z.string().min(20),
});
function msSince(t0) {
    return Date.now() - t0;
}
function hashInviteCode(code) {
    const secret = process.env.INVITE_CODE_SECRET || "";
    return node_crypto_1.default.createHash("sha256").update(`${code}:${secret}`).digest("hex");
}
/**
 * POST /api/customer/register/prefill
 * Body: { token }
 * Returns: { baid, zip, inviteCode, email, orderNbr }
 */
exports.customerAuthRouter.post("/register/prefill", async (req, res) => {
    const parsed = REGISTER_PREFILL_BODY.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request body" });
    }
    try {
        const prefill = (0, registrationPrefillToken_1.verifyRegistrationPrefillToken)(parsed.data.token);
        const existing = await prisma_1.prisma.users.findUnique({
            where: { email: prefill.email.toLowerCase().trim() },
            select: { id: true },
        });
        return res.json({
            baid: prefill.baid,
            zip: prefill.zip,
            inviteCode: prefill.inviteCode,
            email: prefill.email,
            orderNbr: prefill.orderNbr,
            existingAccount: Boolean(existing),
        });
    }
    catch {
        return res.status(400).json({ message: "Invalid or expired link" });
    }
});
/**
 * POST /api/customer/register
 * Body: { name, email, phone, baid, zip, inviteCode, password }
 * Returns: { user }
 */
exports.customerAuthRouter.post("/register", async (req, res) => {
    const t0 = Date.now();
    const parsed = REGISTER_BODY.safeParse(req.body);
    if (!parsed.success) {
        console.warn("[willcall][customer][register] invalid body", {
            reasonCode: REGISTER_REASON.InvalidBody,
            issues: parsed.error.issues,
            ms: msSince(t0),
        });
        return res.status(400).json({
            message: "Invalid request body",
            reasonCode: REGISTER_REASON.InvalidBody,
        });
    }
    const name = parsed.data.name.trim();
    const email = parsed.data.email.toLowerCase().trim();
    const phone = parsed.data.phone; // digits-only
    const baid = parsed.data.baid; // uppercased
    const zip = parsed.data.zip;
    const inviteCode = parsed.data.inviteCode;
    console.log("[willcall][customer][register] start", {
        email,
        baid,
    });
    const rule = (0, passwords_1.validatePasswordRules)(parsed.data.password);
    if (!rule.ok) {
        const reasonCode = rule.message === "Password must be at least 8 characters."
            ? REGISTER_REASON.PasswordTooShort
            : rule.message === "Password must include at least 1 number."
                ? REGISTER_REASON.PasswordNumberRequired
                : REGISTER_REASON.PasswordSymbolRequired;
        console.warn("[willcall][customer][register] password rules failed", {
            email,
            baid,
            reasonCode,
            reason: rule.message,
            ms: msSince(t0),
        });
        return res.status(400).json({ message: rule.message, reasonCode });
    }
    const existing = await prisma_1.prisma.users.findUnique({ where: { email } });
    if (existing) {
        console.warn("[willcall][customer][register] email already exists", {
            email,
            userId: existing.id,
            reasonCode: REGISTER_REASON.EmailAlreadyExists,
            ms: msSince(t0),
        });
        return res.status(409).json({
            message: "An account with that email already exists",
            reasonCode: REGISTER_REASON.EmailAlreadyExists,
        });
    }
    const passwordHash = await (0, passwords_1.hashPassword)(parsed.data.password);
    try {
        const verified = await (0, verifyBaid_1.verifyBaidInAcumatica)(baid, zip);
        if (!verified) {
            console.warn("[willcall][customer][register] baid verification failed", {
                email,
                baid,
                reasonCode: REGISTER_REASON.DetailsNotConfirmed,
                ms: msSince(t0),
            });
            return res.status(400).json({
                message: "We couldn't confirm these details. Please contact your salesperson.",
                reasonCode: REGISTER_REASON.DetailsNotConfirmed,
            });
        }
        const now = new Date();
        const codeHash = hashInviteCode(inviteCode);
        const invite = await prisma_1.prisma.inviteCode.findFirst({
            where: {
                baid,
                status: "Pending",
                expiresAt: { gt: now },
                codeHash,
            },
        });
        if (!invite) {
            console.warn("[willcall][customer][register] invite invalid", {
                email,
                baid,
                reasonCode: REGISTER_REASON.DetailsNotConfirmed,
                ms: msSince(t0),
            });
            return res.status(400).json({
                message: "We couldn't confirm these details. Please contact your salesperson.",
                reasonCode: REGISTER_REASON.DetailsNotConfirmed,
            });
        }
        if (!process.env.NOTIFICATIONS_TEST_EMAIL && invite.recipientEmail) {
            const match = invite.recipientEmail.toLowerCase().trim() === email;
            if (!match) {
                console.warn("[willcall][customer][register] invite email mismatch", {
                    email,
                    baid,
                    reasonCode: REGISTER_REASON.DetailsNotConfirmed,
                    ms: msSince(t0),
                });
                return res.status(400).json({
                    message: "We couldn't confirm these details. Please contact your salesperson.",
                    reasonCode: REGISTER_REASON.DetailsNotConfirmed,
                });
            }
        }
        const adminCount = await prisma_1.prisma.accountUserRole.count({
            where: { baid, role: "ADMIN", isActive: true },
        });
        const assignedRole = adminCount > 0 ? invite.role : "ADMIN";
        const user = await prisma_1.prisma.$transaction(async (tx) => {
            const created = await tx.users.create({
                data: {
                    id: node_crypto_1.default.randomUUID(),
                    name,
                    email,
                    baid,
                    emailVerified: false,
                    updatedAt: now,
                },
            });
            await tx.customerCredential.create({
                data: {
                    userId: created.id,
                    passwordHash,
                    phone,
                },
            });
            await tx.accountUserRole.create({
                data: {
                    id: node_crypto_1.default.randomUUID(),
                    baid,
                    userId: created.id,
                    role: assignedRole,
                    isActive: true,
                    updatedAt: now,
                },
            });
            await tx.inviteCode.update({
                where: { id: invite.id },
                data: {
                    status: "Used",
                    usedAt: now,
                    usedByUserId: created.id,
                },
            });
            return created;
        });
        console.log("[willcall][customer][register] success", {
            userId: user.id,
            email: user.email,
            baid: user.baid,
            reasonCode: "REGISTER_SUCCESS",
            ms: msSince(t0),
        });
        return res.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                baid: user.baid,
                phone,
                emailVerified: user.emailVerified,
                accountRole: assignedRole,
            },
        });
    }
    catch (err) {
        console.error("[willcall][customer][register] error", {
            email,
            baid,
            reasonCode: REGISTER_REASON.RegisterFailed,
            ms: msSince(t0),
            error: err?.message ?? String(err),
        });
        return res.status(500).json({
            message: "Failed to register",
            reasonCode: REGISTER_REASON.RegisterFailed,
        });
    }
});
/**
 * POST /api/customer/verify-baid
 * Body: { baid }
 * Returns: { ok: true } if BAID exists in Acumatica
 *
 * Note: This endpoint does NOT write to the database.
 * The BAID is persisted during /api/customer/register.
 */
exports.customerAuthRouter.post("/verify-baid", async (req, res) => {
    const t0 = Date.now();
    const parsed = VERIFY_BAID_BODY.safeParse(req.body);
    if (!parsed.success) {
        console.warn("[willcall][customer][verify-baid] invalid body", {
            issues: parsed.error.issues,
            ms: msSince(t0),
        });
        return res.status(400).json({ ok: false, message: "Invalid BAID" });
    }
    const baid = parsed.data.baid;
    const zip = parsed.data.zip;
    console.log("[willcall][customer][verify-baid] start", { baid });
    try {
        const exists = await (0, verifyBaid_1.verifyBaidInAcumatica)(baid, zip);
        console.log("[willcall][customer][verify-baid] result", {
            baid,
            exists,
            ms: msSince(t0),
        });
        if (!exists) {
            return res.status(404).json({
                ok: false,
                message: "We couldn't confirm these details. Please contact your salesperson.",
            });
        }
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("[willcall][customer][verify-baid] error", {
            baid,
            ms: msSince(t0),
            error: err?.message ?? String(err),
        });
        return res.status(500).json({ ok: false, message: "Unable to verify BAID right now" });
    }
});
/**
 * POST /api/customer/login
 * Body: { email, password }
 * Returns: { user }
 */
exports.customerAuthRouter.post("/login", async (req, res) => {
    const t0 = Date.now();
    const parsed = LOGIN_BODY.safeParse(req.body);
    if (!parsed.success) {
        console.warn("[willcall][customer][login] invalid body", {
            issues: parsed.error.issues,
            ms: msSince(t0),
        });
        return res.status(400).json({ message: "Invalid request body" });
    }
    const email = parsed.data.email.toLowerCase().trim();
    const password = parsed.data.password;
    console.log("[willcall][customer][login] start", { email });
    const throttle = await (0, loginThrottle_1.getLoginThrottleState)("customer", email);
    if (throttle.blocked) {
        return res.status(429).json({
            message: "Too many failed attempts. Account temporarily locked.",
            attemptsLeft: 0,
            lockedUntil: throttle.lockedUntil?.toISOString(),
        });
    }
    const user = await prisma_1.prisma.users.findUnique({ where: { email } });
    if (!user) {
        const failed = await (0, loginThrottle_1.recordFailedLogin)("customer", email);
        console.warn("[willcall][customer][login] invalid credentials (no user)", {
            email,
            attemptsLeft: failed.attemptsLeft,
            ms: msSince(t0),
        });
        if (failed.blocked) {
            return res.status(429).json({
                message: "Too many failed attempts. Account temporarily locked.",
                attemptsLeft: 0,
                lockedUntil: failed.lockedUntil?.toISOString(),
            });
        }
        return res.status(401).json({
            message: `Invalid credentials. ${failed.attemptsLeft} attempts left.`,
            attemptsLeft: failed.attemptsLeft,
        });
    }
    const cred = await prisma_1.prisma.customerCredential.findUnique({ where: { userId: user.id } });
    if (!cred) {
        const failed = await (0, loginThrottle_1.recordFailedLogin)("customer", email);
        console.warn("[willcall][customer][login] invalid credentials (no cred)", {
            email,
            userId: user.id,
            attemptsLeft: failed.attemptsLeft,
            ms: msSince(t0),
        });
        if (failed.blocked) {
            return res.status(429).json({
                message: "Too many failed attempts. Account temporarily locked.",
                attemptsLeft: 0,
                lockedUntil: failed.lockedUntil?.toISOString(),
            });
        }
        return res.status(401).json({
            message: `Invalid credentials. ${failed.attemptsLeft} attempts left.`,
            attemptsLeft: failed.attemptsLeft,
        });
    }
    const ok = await (0, passwords_1.verifyPassword)(password, cred.passwordHash);
    if (!ok) {
        const failed = await (0, loginThrottle_1.recordFailedLogin)("customer", email);
        console.warn("[willcall][customer][login] invalid credentials (bad password)", {
            email,
            userId: user.id,
            attemptsLeft: failed.attemptsLeft,
            ms: msSince(t0),
        });
        if (failed.blocked) {
            return res.status(429).json({
                message: "Too many failed attempts. Account temporarily locked.",
                attemptsLeft: 0,
                lockedUntil: failed.lockedUntil?.toISOString(),
            });
        }
        return res.status(401).json({
            message: `Invalid credentials. ${failed.attemptsLeft} attempts left.`,
            attemptsLeft: failed.attemptsLeft,
        });
    }
    await (0, loginThrottle_1.clearFailedLogin)("customer", email);
    console.log("[willcall][customer][login] success", {
        userId: user.id,
        email,
        ms: msSince(t0),
    });
    const roles = await prisma_1.prisma.accountUserRole.findMany({
        where: { userId: user.id, isActive: true },
    });
    const accountRole = roles.find((r) => r.role === "ADMIN")?.role ??
        roles.find((r) => r.role === "PM")?.role ??
        null;
    return res.json({
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            baid: user.baid,
            phone: cred.phone,
            emailVerified: user.emailVerified,
            accountRole,
            isDeveloper: Boolean(user.isDeveloper),
        },
    });
});
