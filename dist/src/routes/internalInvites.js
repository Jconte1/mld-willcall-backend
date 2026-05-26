"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalInvitesRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const verifyBaid_1 = require("../lib/acumatica/verifyBaid");
const registrationPrefillToken_1 = require("../lib/registrationPrefillToken");
const sendEmail_1 = require("../notifications/providers/email/sendEmail");
const buildInviteEmail_1 = require("../notifications/templates/email/buildInviteEmail");
const appUrls_1 = require("../lib/appUrls");
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
        console.info("[internal-invites] unauthorized", {
            hasToken: Boolean(INTERNAL_TOKEN),
            hasAuthHeader: Boolean(auth),
            authPrefix: auth ? auth.slice(0, 8) : "",
        });
        return res.status(401).json({ message: "Unauthorized" });
    }
    return next();
}
exports.internalInvitesRouter.post("/dispatch", requireInternalAuth, async (req, res) => {
    const parsed = DISPATCH_BODY.safeParse(req.body);
    if (!parsed.success) {
        console.info("[internal-invites] invalid body", {
            issues: parsed.error.issues.map((issue) => issue.message),
        });
        return res.status(400).json({ message: "Invalid request body" });
    }
    const baid = normalizeBaid(parsed.data.customerId);
    const zip = normalizeZip(parsed.data.billingZip);
    const email = parsed.data.email.toLowerCase().trim();
    const shouldSendEmail = Boolean(parsed.data.sendEmail);
    const existingUser = await prisma_1.prisma.users.findUnique({
        where: { email },
        select: { id: true, baid: true },
    });
    const existingUserBaid = normalizeBaid(existingUser?.baid || "");
    if (existingUser && existingUserBaid && existingUserBaid !== baid) {
        console.info("[internal-invites] blocked existing linked user with different BAID", {
            email,
            existingUserId: existingUser.id,
            existingBaid: existingUserBaid,
            requestedBaid: baid,
        });
        return res.status(409).json({
            message: "An account already exists for this email and is already linked to a Customer ID#.",
        });
    }
    if (!BAID_REGEX.test(baid) || zip.length !== 5) {
        console.info("[internal-invites] invalid inputs", {
            hasBaid: Boolean(baid),
            hasZip: Boolean(zip),
            zipLen: zip.length,
        });
        return res.status(400).json({ message: "Invalid Customer ID# or ZIP" });
    }
    try {
        const verified = await (0, verifyBaid_1.verifyBaidInAcumatica)(baid, zip);
        if (!verified) {
            let diagnostics = null;
            try {
                diagnostics = await (0, verifyBaid_1.diagnoseBaidZipInAcumatica)(baid, zip);
            }
            catch (diagErr) {
                console.info("[internal-invites] verify diagnostics error", {
                    baid,
                    zipSent: parsed.data.billingZip,
                    zipNormalized: zip,
                    message: String(diagErr?.message || diagErr),
                });
            }
            console.info("[internal-invites] verify failed", {
                baid,
                zipSent: parsed.data.billingZip,
                zipNormalized: zip,
                compareMode: diagnostics?.mode || "unknown",
                acumaticaMatched: diagnostics?.matched ?? false,
                acumaticaCandidateZip5: diagnostics?.candidateZip5 || [],
            });
            return res.status(400).json({ message: "Invalid Customer ID# or ZIP" });
        }
    }
    catch (err) {
        console.info("[internal-invites] verify error", {
            baid,
            message: String(err?.message || err),
        });
        return res.status(502).json({ message: "Unable to verify right now" });
    }
    const now = new Date();
    const existing = await prisma_1.prisma.inviteCode.findFirst({
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
        console.info("[internal-invites] issuing new code", { baid, hasExisting: Boolean(existing) });
        code = generateInviteCode();
        const codeHash = hashInviteCode(code);
        const nextExpiresAt = new Date(now.getTime() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
        if (existing) {
            const updated = await prisma_1.prisma.inviteCode.update({
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
            const created = await prisma_1.prisma.inviteCode.create({
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
        const frontendUrl = (0, appUrls_1.getFrontendBaseUrl)();
        let prefillToken = null;
        try {
            prefillToken = (0, registrationPrefillToken_1.createRegistrationPrefillToken)({
                customerId: baid,
                billingZip: zip,
                inviteCode: code,
                email,
            });
        }
        catch (err) {
            console.warn("[internal-invites] failed to create prefill token; using fallback link", {
                baid,
                email,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        const message = (0, buildInviteEmail_1.buildInviteEmail)(code, baid, "Manager", frontendUrl, zip, prefillToken);
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
