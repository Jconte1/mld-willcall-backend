"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalInvitesRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const verifyBaid_1 = require("../lib/acumatica/verifyBaid");
const sendEmail_1 = require("../notifications/providers/email/sendEmail");
const buildInviteEmail_1 = require("../notifications/templates/email/buildInviteEmail");
const prisma = new client_1.PrismaClient();
exports.internalInvitesRouter = (0, express_1.Router)();
const INTERNAL_TOKEN = process.env.INTERNAL_INVITE_TOKEN || "";
const BAID_REGEX = /^BA\d{7}$/;
const INVITE_EXPIRY_HOURS = 48;
const DISPATCH_BODY = zod_1.z.object({
    customerId: zod_1.z.string().min(1),
    billingZip: zod_1.z.string().min(1),
    email: zod_1.z.string().email(),
    sendEmail: zod_1.z.boolean().optional(),
});
function hashInviteCode(code) {
    const secret = process.env.INVITE_CODE_SECRET || "";
    return node_crypto_1.default.createHash("sha256").update(`${code}:${secret}`).digest("hex");
}
function generateInviteCode() {
    const digits = node_crypto_1.default.randomInt(0, 999999);
    return String(digits).padStart(6, "0");
}
function normalizeBaid(value) {
    return value.replace(/\s+/g, "").toUpperCase();
}
function normalizeZip(value) {
    return value.replace(/\D/g, "").slice(0, 5);
}
function requireInternalAuth(req, res, next) {
    const auth = String(req.headers.authorization || "");
    if (!INTERNAL_TOKEN || auth !== `Bearer ${INTERNAL_TOKEN}`) {
        return res.status(401).json({ message: "Unauthorized" });
    }
    return next();
}
exports.internalInvitesRouter.post("/dispatch", requireInternalAuth, async (req, res) => {
    const parsed = DISPATCH_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const baid = normalizeBaid(parsed.data.customerId);
    const zip = normalizeZip(parsed.data.billingZip);
    const email = parsed.data.email.toLowerCase().trim();
    const shouldSendEmail = Boolean(parsed.data.sendEmail);
    if (!BAID_REGEX.test(baid) || zip.length !== 5) {
        return res.status(400).json({ message: "Invalid Customer ID# or ZIP" });
    }
    try {
        const verified = await (0, verifyBaid_1.verifyBaidInAcumatica)(baid, zip);
        if (!verified) {
            return res.status(400).json({ message: "Invalid Customer ID# or ZIP" });
        }
    }
    catch (err) {
        return res.status(502).json({ message: "Unable to verify right now" });
    }
    const now = new Date();
    const existing = await prisma.inviteCode.findFirst({
        where: {
            baid,
            recipientEmail: email,
            status: "Pending",
            expiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
    });
    let code = existing?.codePlain || null;
    let inviteId = existing?.id || null;
    let expiresAt = existing?.expiresAt || null;
    if (!code) {
        code = generateInviteCode();
        const codeHash = hashInviteCode(code);
        const nextExpiresAt = new Date(now.getTime() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
        if (existing) {
            const updated = await prisma.inviteCode.update({
                where: { id: existing.id },
                data: {
                    codeHash,
                    codePlain: code,
                    expiresAt: nextExpiresAt,
                    sentAt: now,
                    status: "Pending",
                },
            });
            inviteId = updated.id;
            expiresAt = updated.expiresAt;
        }
        else {
            const created = await prisma.inviteCode.create({
                data: {
                    baid,
                    role: "PM",
                    recipientEmail: email,
                    codeHash,
                    codePlain: code,
                    status: "Pending",
                    expiresAt: nextExpiresAt,
                    sentAt: now,
                },
            });
            inviteId = created.id;
            expiresAt = created.expiresAt;
        }
    }
    if (shouldSendEmail && code) {
        const frontendUrl = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/$/, "");
        const message = (0, buildInviteEmail_1.buildInviteEmail)(code, baid, "Manager", frontendUrl, zip);
        await (0, sendEmail_1.sendEmail)(email, message.subject, message.body, {
            allowTestOverride: false,
            allowNonProdSend: true,
        });
    }
    return res.json({
        ok: true,
        inviteId,
        code,
        expiresAt,
    });
});
