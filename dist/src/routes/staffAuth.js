"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.staffAuthRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const passwords_1 = require("../lib/passwords");
const auth_1 = require("../middleware/auth");
const prisma = new client_1.PrismaClient();
exports.staffAuthRouter = (0, express_1.Router)();
const LOGIN_BODY = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1)
});
/**
 * POST /api/staff/login
 * Body: { email, password }
 * Returns: { token, user }
 *
 * Intended to be used by NextAuth Credentials authorize() on the frontend.
 */
exports.staffAuthRouter.post("/login", async (req, res) => {
    const parsed = LOGIN_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const email = parsed.data.email.toLowerCase();
    if (!email.endsWith("@mld.com"))
        return res.status(401).json({ message: "Invalid credentials" });
    const user = await prisma.staffUser.findUnique({ where: { email } });
    if (!user || !user.isActive)
        return res.status(401).json({ message: "Invalid credentials" });
    const ok = await (0, passwords_1.verifyPassword)(parsed.data.password, user.passwordHash);
    if (!ok)
        return res.status(401).json({ message: "Invalid credentials" });
    const secret = process.env.JWT_SECRET;
    if (!secret)
        return res.status(500).json({ message: "Server misconfigured: JWT_SECRET missing" });
    const token = jsonwebtoken_1.default.sign({
        email: user.email,
        role: user.role,
        locationAccess: user.locationAccess,
        mustChangePassword: user.mustChangePassword
    }, secret, {
        subject: user.id,
        expiresIn: "7d"
    });
    return res.json({
        token,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            locationAccess: user.locationAccess,
            mustChangePassword: user.mustChangePassword,
            isActive: user.isActive
        }
    });
});
/**
 * POST /api/staff/change-password
 * Protected
 * Body: { currentPassword, newPassword }
 * Requires current password. Enforces password rules.
 * Sets mustChangePassword = false on success.
 */
exports.staffAuthRouter.post("/change-password", auth_1.requireAuth, async (req, res) => {
    const body = zod_1.z.object({
        currentPassword: zod_1.z.string().min(1),
        newPassword: zod_1.z.string().min(1)
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const user = await prisma.staffUser.findUnique({ where: { id: req.auth.id } });
    if (!user || !user.isActive)
        return res.status(401).json({ message: "Unauthorized" });
    const ok = await (0, passwords_1.verifyPassword)(body.data.currentPassword, user.passwordHash);
    if (!ok)
        return res.status(400).json({ message: "Current password is incorrect" });
    const rule = (0, passwords_1.validatePasswordRules)(body.data.newPassword);
    if (!rule.ok)
        return res.status(400).json({ message: rule.message });
    const newHash = await (0, passwords_1.hashPassword)(body.data.newPassword);
    await prisma.staffUser.update({
        where: { id: user.id },
        data: { passwordHash: newHash, mustChangePassword: false }
    });
    return res.json({ ok: true });
});
