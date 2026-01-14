"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customerAuthRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const passwords_1 = require("../lib/passwords");
const verifyBaid_1 = require("../lib/acumatica/verifyBaid");
const prisma = new client_1.PrismaClient();
exports.customerAuthRouter = (0, express_1.Router)();
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
    password: zod_1.z.string().min(1),
});
const VERIFY_BAID_BODY = zod_1.z.object({
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
});
const LOGIN_BODY = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1),
});
function msSince(t0) {
    return Date.now() - t0;
}
/**
 * POST /api/customer/register
 * Body: { name, email, phone, baid, password }
 * Returns: { user }
 */
exports.customerAuthRouter.post("/register", async (req, res) => {
    const t0 = Date.now();
    const parsed = REGISTER_BODY.safeParse(req.body);
    if (!parsed.success) {
        console.warn("[willcall][customer][register] invalid body", {
            issues: parsed.error.issues,
            ms: msSince(t0),
        });
        return res.status(400).json({ message: "Invalid request body" });
    }
    const name = parsed.data.name.trim();
    const email = parsed.data.email.toLowerCase().trim();
    const phone = parsed.data.phone; // digits-only
    const baid = parsed.data.baid; // uppercased
    console.log("[willcall][customer][register] start", {
        email,
        baid,
    });
    const rule = (0, passwords_1.validatePasswordRules)(parsed.data.password);
    if (!rule.ok) {
        console.warn("[willcall][customer][register] password rules failed", {
            email,
            baid,
            reason: rule.message,
            ms: msSince(t0),
        });
        return res.status(400).json({ message: rule.message });
    }
    const existing = await prisma.users.findUnique({ where: { email } });
    if (existing) {
        console.warn("[willcall][customer][register] email already exists", {
            email,
            userId: existing.id,
            ms: msSince(t0),
        });
        return res.status(409).json({ message: "An account with that email already exists" });
    }
    const passwordHash = await (0, passwords_1.hashPassword)(parsed.data.password);
    try {
        const user = await prisma.$transaction(async (tx) => {
            const now = new Date();
            const created = await tx.users.create({
                data: {
                    id: crypto.randomUUID(),
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
            return created;
        });
        console.log("[willcall][customer][register] success", {
            userId: user.id,
            email: user.email,
            baid: user.baid,
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
            },
        });
    }
    catch (err) {
        console.error("[willcall][customer][register] error", {
            email,
            baid,
            ms: msSince(t0),
            error: err?.message ?? String(err),
        });
        return res.status(500).json({ message: "Failed to register" });
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
    console.log("[willcall][customer][verify-baid] start", { baid });
    try {
        const exists = await (0, verifyBaid_1.verifyBaidInAcumatica)(baid);
        console.log("[willcall][customer][verify-baid] result", {
            baid,
            exists,
            ms: msSince(t0),
        });
        if (!exists) {
            return res.status(404).json({ ok: false, message: "BAID not found" });
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
    const user = await prisma.users.findUnique({ where: { email } });
    if (!user) {
        console.warn("[willcall][customer][login] invalid credentials (no user)", {
            email,
            ms: msSince(t0),
        });
        return res.status(401).json({ message: "Invalid credentials" });
    }
    const cred = await prisma.customerCredential.findUnique({ where: { userId: user.id } });
    if (!cred) {
        console.warn("[willcall][customer][login] invalid credentials (no cred)", {
            email,
            userId: user.id,
            ms: msSince(t0),
        });
        return res.status(401).json({ message: "Invalid credentials" });
    }
    const ok = await (0, passwords_1.verifyPassword)(password, cred.passwordHash);
    if (!ok) {
        console.warn("[willcall][customer][login] invalid credentials (bad password)", {
            email,
            userId: user.id,
            ms: msSince(t0),
        });
        return res.status(401).json({ message: "Invalid credentials" });
    }
    console.log("[willcall][customer][login] success", {
        userId: user.id,
        email,
        ms: msSince(t0),
    });
    return res.json({
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            baid: user.baid,
            phone: cred.phone,
            emailVerified: user.emailVerified,
        },
    });
});
