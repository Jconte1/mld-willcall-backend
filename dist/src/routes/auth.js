"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const tokens_1 = require("../lib/tokens");
const passwords_1 = require("../lib/passwords");
const email_1 = require("../lib/email");
const prisma = new client_1.PrismaClient();
exports.authRouter = (0, express_1.Router)();
/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Sends email with reset link (valid 1 hour)
 */
exports.authRouter.post("/forgot-password", async (req, res) => {
    const body = zod_1.z.object({ email: zod_1.z.string().email() }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const email = body.data.email.toLowerCase();
    const user = await prisma.staffUser.findUnique({ where: { email } });
    // Always return 200 to avoid leaking which emails exist.
    if (!user || !user.isActive)
        return res.json({ ok: true });
    const rawToken = (0, tokens_1.makeRandomToken)(32);
    const tokenHash = (0, tokens_1.sha256)(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await prisma.passwordResetToken.create({
        data: {
            staffUserId: user.id,
            tokenHash,
            expiresAt
        }
    });
    const frontend = process.env.FRONTEND_URL ?? "https://mld-willcall.vercel.app";
    const resetUrl = `${frontend.replace(/\/$/, "")}/staff/reset-password?token=${rawToken}`;
    await (0, email_1.sendPasswordResetEmail)({ to: email, resetUrl });
    return res.json({ ok: true });
});
/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 * Resets password using emailed token. Token valid 1 hour.
 * After reset: mustChangePassword = false
 */
exports.authRouter.post("/reset-password", async (req, res) => {
    const body = zod_1.z.object({
        token: zod_1.z.string().min(10),
        newPassword: zod_1.z.string().min(1)
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const rule = (0, passwords_1.validatePasswordRules)(body.data.newPassword);
    if (!rule.ok)
        return res.status(400).json({ message: rule.message });
    const tokenHash = (0, tokens_1.sha256)(body.data.token);
    const record = await prisma.passwordResetToken.findFirst({
        where: {
            tokenHash,
            usedAt: null,
            expiresAt: { gt: new Date() }
        },
        include: { staffUser: true }
    });
    if (!record || !record.staffUser.isActive) {
        return res.status(400).json({ message: "Invalid or expired token" });
    }
    const newHash = await (0, passwords_1.hashPassword)(body.data.newPassword);
    await prisma.$transaction([
        prisma.staffUser.update({
            where: { id: record.staffUserId },
            data: { passwordHash: newHash, mustChangePassword: false }
        }),
        prisma.passwordResetToken.update({
            where: { id: record.id },
            data: { usedAt: new Date() }
        })
    ]);
    return res.json({ ok: true });
});
