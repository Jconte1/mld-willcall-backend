"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.customerInvitesRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const verifyBaid_1 = require("../lib/acumatica/verifyBaid");
const sendEmail_1 = require("../notifications/providers/email/sendEmail");
const buildInviteEmail_1 = require("../notifications/templates/email/buildInviteEmail");
const prisma = new client_1.PrismaClient();
exports.customerInvitesRouter = (0, express_1.Router)();
const BAID_REGEX = /^BA\d{7}$/;
const REQUEST_INVITE_BODY = zod_1.z.object({
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    zip: zod_1.z
        .string()
        .transform((v) => v.replace(/\D/g, "").slice(0, 5))
        .refine((v) => /^\d{5}$/.test(v), { message: "ZIP must be 5 digits" }),
});
const LIST_BODY = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
});
const CREATE_INVITE_BODY = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    name: zod_1.z.string().min(1),
    email: zod_1.z.string().email().transform((v) => v.toLowerCase().trim()),
    phone: zod_1.z.string().optional(),
    role: zod_1.z.enum(["ADMIN", "PM"]),
});
const REVOKE_INVITE_BODY = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    inviteId: zod_1.z.string().min(1),
});
const UPDATE_ROLE_BODY = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    targetUserId: zod_1.z.string().min(1),
    role: zod_1.z.enum(["ADMIN", "PM"]),
});
const REMOVE_MEMBER_BODY = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    baid: zod_1.z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
    targetUserId: zod_1.z.string().min(1),
});
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
const INVITE_EXPIRY_HOURS = 48;
function hashInviteCode(code) {
    const secret = process.env.INVITE_CODE_SECRET || "";
    return node_crypto_1.default.createHash("sha256").update(`${code}:${secret}`).digest("hex");
}
function generateInviteCode() {
    const digits = node_crypto_1.default.randomInt(0, 999999);
    return String(digits).padStart(6, "0");
}
function resolveInviteRecipient(email, { allowTestOverride = true } = {}) {
    if (allowTestOverride && process.env.NOTIFICATIONS_TEST_EMAIL) {
        // TODO: Remove test override for production invites.
        return process.env.NOTIFICATIONS_TEST_EMAIL;
    }
    return email || "";
}
function getClientIp(req) {
    const xf = req.headers["x-forwarded-for"] || "";
    if (xf)
        return xf.split(",")[0].trim();
    return req.ip || req.connection?.remoteAddress || "";
}
async function hasAdminForBaid(baid) {
    const count = await prisma.accountUserRole.count({
        where: { baid, role: "ADMIN", isActive: true },
    });
    return count > 0;
}
async function getAccess(userId, baid) {
    const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { id: true, isDeveloper: true },
    });
    if (!user)
        return { user: null, role: null, isDeveloper: false };
    if (user.isDeveloper)
        return { user, role: "ADMIN", isDeveloper: true };
    const roleRow = await prisma.accountUserRole.findFirst({
        where: { userId, baid, isActive: true },
    });
    return { user, role: roleRow?.role ?? null, isDeveloper: false };
}
async function ensureAdmin(userId, baid) {
    const access = await getAccess(userId, baid);
    if (!access.user)
        return { ok: false, status: 404 };
    if (access.isDeveloper)
        return { ok: true, access };
    if (access.role !== "ADMIN")
        return { ok: false, status: 403 };
    return { ok: true, access };
}
async function ensureMember(userId, baid) {
    const access = await getAccess(userId, baid);
    if (!access.user)
        return { ok: false, status: 404 };
    if (access.isDeveloper)
        return { ok: true, access };
    if (!access.role)
        return { ok: false, status: 403 };
    return { ok: true, access };
}
async function logInviteRequest(opts) {
    try {
        await prisma.inviteRequestLog.create({ data: opts });
    }
    catch {
        // best-effort logging
    }
}
async function checkLockout(key) {
    const row = await prisma.inviteLockout.findUnique({ where: { key } });
    if (!row?.lockedUntil)
        return { locked: false };
    if (row.lockedUntil.getTime() <= Date.now())
        return { locked: false };
    return { locked: true, lockedUntil: row.lockedUntil };
}
async function recordAttempt(key, ok) {
    const now = new Date();
    const row = await prisma.inviteLockout.findUnique({ where: { key } });
    if (!row) {
        await prisma.inviteLockout.create({
            data: {
                key,
                attemptCount: ok ? 0 : 1,
                lastAttemptAt: now,
                lockedUntil: ok ? null : null,
            },
        });
        return;
    }
    if (ok) {
        await prisma.inviteLockout.update({
            where: { key },
            data: { attemptCount: 0, lastAttemptAt: now, lockedUntil: null },
        });
        return;
    }
    const withinWindow = row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < LOCKOUT_WINDOW_MS;
    const nextCount = withinWindow ? row.attemptCount + 1 : 1;
    const lockedUntil = nextCount >= LOCKOUT_MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_WINDOW_MS) : null;
    await prisma.inviteLockout.update({
        where: { key },
        data: { attemptCount: nextCount, lastAttemptAt: now, lockedUntil },
    });
}
async function sendInviteEmail(opts) {
    const frontendUrl = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/$/, "");
    const message = (0, buildInviteEmail_1.buildInviteEmail)(opts.code, opts.baid, opts.roleLabel, frontendUrl, opts.zipCode);
    await (0, sendEmail_1.sendEmail)(opts.recipient, message.subject, message.body, {
        allowTestOverride: opts.allowTestOverride,
        allowNonProdSend: opts.allowTestOverride === false,
    });
}
async function revokePendingInvites(baid) {
    await prisma.inviteCode.updateMany({
        where: { baid, status: "Pending" },
        data: { status: "Revoked" },
    });
}
async function assignAdminIfNeeded(baid) {
    const hasAdmin = await hasAdminForBaid(baid);
    if (hasAdmin)
        return;
    const manager = await prisma.accountUserRole.findFirst({
        where: { baid, role: "PM", isActive: true },
        orderBy: { createdAt: "asc" },
    });
    if (!manager)
        return;
    await prisma.accountUserRole.update({
        where: { id: manager.id },
        data: { role: "ADMIN" },
    });
}
exports.customerInvitesRouter.post("/request", async (req, res) => {
    const parsed = REQUEST_INVITE_BODY.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request body" });
    }
    const baid = parsed.data.baid;
    const zip = parsed.data.zip;
    const ip = getClientIp(req);
    const userAgent = String(req.headers["user-agent"] || "");
    const lockKey = `baid:${baid}`;
    const ipKey = ip ? `ip:${ip}` : "";
    const [baidLock, ipLock] = await Promise.all([
        checkLockout(lockKey),
        ipKey ? checkLockout(ipKey) : Promise.resolve({ locked: false }),
    ]);
    if (baidLock.locked || ipLock.locked) {
        await logInviteRequest({
            baid,
            ip,
            userAgent,
            result: "locked",
            reason: "rate-limit",
        });
        return res.status(429).json({
            status: "locked",
            message: "Too many attempts. Please contact support.",
        });
    }
    let verified = false;
    try {
        verified = await (0, verifyBaid_1.verifyBaidInAcumatica)(baid, zip);
    }
    catch (err) {
        await logInviteRequest({
            baid,
            ip,
            userAgent,
            result: "error",
            reason: String(err?.message || err),
        });
        return res.status(502).json({ message: "Unable to verify right now." });
    }
    await recordAttempt(lockKey, verified);
    if (ipKey)
        await recordAttempt(ipKey, verified);
    if (!verified) {
        await logInviteRequest({
            baid,
            ip,
            userAgent,
            result: "failed",
            reason: "no-match",
        });
        return res.json({ ok: true });
    }
    const adminExists = await hasAdminForBaid(baid);
    if (adminExists) {
        await logInviteRequest({
            baid,
            ip,
            userAgent,
            result: "admin-required",
        });
        return res.json({
            ok: true,
            status: "admin-required",
            message: "Please contact your account administrator for access.",
        });
    }
    await revokePendingInvites(baid);
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
    const recipient = resolveInviteRecipient(process.env.NOTIFICATIONS_TEST_EMAIL || "", {
        allowTestOverride: true,
    });
    await prisma.inviteCode.create({
        data: {
            baid,
            role: "ADMIN",
            recipientEmail: recipient || null,
            codeHash,
            codePlain: code,
            status: "Pending",
            expiresAt,
            sentAt: new Date(),
        },
    });
    if (recipient) {
        await sendInviteEmail({
            recipient,
            code,
            baid,
            roleLabel: "Admin",
            zipCode: zip,
            allowTestOverride: true,
        });
    }
    await logInviteRequest({
        baid,
        ip,
        userAgent,
        result: "sent",
    });
    return res.json({ ok: true });
});
exports.customerInvitesRouter.post("/invitations/list", async (req, res) => {
    const parsed = LIST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureMember(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    const invites = await prisma.inviteCode.findMany({
        where: { baid: parsed.data.baid },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            baid: true,
            role: true,
            recipientEmail: true,
            recipientPhone: true,
            status: true,
            createdAt: true,
            expiresAt: true,
            usedAt: true,
        },
    });
    return res.json({ invites });
});
exports.customerInvitesRouter.post("/invitations", async (req, res) => {
    const parsed = CREATE_INVITE_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureAdmin(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    await revokePendingInvites(parsed.data.baid);
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
    const recipient = resolveInviteRecipient(parsed.data.email, { allowTestOverride: false });
    // TODO: Remove this log once production-ready.
    console.log("[invites][member] recipient resolved", {
        inputEmail: parsed.data.email,
        resolved: recipient,
        allowTestOverride: false,
        hasTestOverride: Boolean(process.env.NOTIFICATIONS_TEST_EMAIL),
    });
    const invite = await prisma.inviteCode.create({
        data: {
            baid: parsed.data.baid,
            role: parsed.data.role,
            recipientEmail: parsed.data.email,
            recipientPhone: parsed.data.phone ?? null,
            codeHash,
            codePlain: code,
            status: "Pending",
            expiresAt,
            sentAt: new Date(),
            createdByUserId: parsed.data.userId,
        },
    });
    await prisma.roleAuditLog.create({
        data: {
            baid: parsed.data.baid,
            actorUserId: parsed.data.userId,
            action: "INVITE_SENT",
            toRole: parsed.data.role,
            note: `Invite ${invite.id}`,
        },
    });
    if (recipient) {
        const roleLabel = parsed.data.role === "ADMIN" ? "Admin" : "Manager";
        await sendInviteEmail({
            recipient,
            code,
            baid: parsed.data.baid,
            roleLabel,
            zipCode: null,
            allowTestOverride: false,
        });
    }
    return res.json({ ok: true });
});
exports.customerInvitesRouter.post("/invitations/revoke", async (req, res) => {
    const parsed = REVOKE_INVITE_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureAdmin(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    await prisma.inviteCode.updateMany({
        where: { id: parsed.data.inviteId, baid: parsed.data.baid, status: "Pending" },
        data: { status: "Revoked" },
    });
    await prisma.roleAuditLog.create({
        data: {
            baid: parsed.data.baid,
            actorUserId: parsed.data.userId,
            action: "INVITE_REVOKED",
            note: `Invite ${parsed.data.inviteId}`,
        },
    });
    return res.json({ ok: true });
});
exports.customerInvitesRouter.post("/members/list", async (req, res) => {
    const parsed = LIST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureMember(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    const roles = await prisma.accountUserRole.findMany({
        where: { baid: parsed.data.baid, isActive: true },
        include: {
            users: {
                select: { id: true, name: true, email: true },
            },
        },
        orderBy: { createdAt: "asc" },
    });
    const userIds = roles.map((r) => r.userId);
    const sessions = await prisma.sessions.findMany({
        where: { userId: { in: userIds } },
        orderBy: { updatedAt: "desc" },
        select: { userId: true, updatedAt: true },
    });
    const lastActiveMap = new Map();
    for (const session of sessions) {
        if (!lastActiveMap.has(session.userId)) {
            lastActiveMap.set(session.userId, session.updatedAt);
        }
    }
    const members = roles.map((role) => ({
        userId: role.userId,
        name: role.users?.name ?? "",
        email: role.users?.email ?? "",
        role: role.role,
        lastActiveAt: lastActiveMap.get(role.userId) ?? null,
    }));
    return res.json({ members });
});
exports.customerInvitesRouter.post("/members/role", async (req, res) => {
    const parsed = UPDATE_ROLE_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureAdmin(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    const existing = await prisma.accountUserRole.findFirst({
        where: {
            baid: parsed.data.baid,
            userId: parsed.data.targetUserId,
            isActive: true,
        },
    });
    if (!existing)
        return res.status(404).json({ message: "Member not found" });
    const updated = await prisma.accountUserRole.update({
        where: { id: existing.id },
        data: { role: parsed.data.role },
    });
    await prisma.roleAuditLog.create({
        data: {
            baid: parsed.data.baid,
            actorUserId: parsed.data.userId,
            targetUserId: parsed.data.targetUserId,
            action: "ROLE_UPDATED",
            fromRole: existing.role,
            toRole: parsed.data.role,
        },
    });
    if (existing.role === "ADMIN" && parsed.data.role !== "ADMIN") {
        await assignAdminIfNeeded(parsed.data.baid);
    }
    return res.json({ ok: true, role: updated.role });
});
exports.customerInvitesRouter.post("/members/remove", async (req, res) => {
    const parsed = REMOVE_MEMBER_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureAdmin(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    const existing = await prisma.accountUserRole.findFirst({
        where: {
            baid: parsed.data.baid,
            userId: parsed.data.targetUserId,
            isActive: true,
        },
    });
    if (!existing)
        return res.status(404).json({ message: "Member not found" });
    await prisma.accountUserRole.update({
        where: { id: existing.id },
        data: { isActive: false },
    });
    await prisma.roleAuditLog.create({
        data: {
            baid: parsed.data.baid,
            actorUserId: parsed.data.userId,
            targetUserId: parsed.data.targetUserId,
            action: "MEMBER_REMOVED",
            fromRole: existing.role,
        },
    });
    if (existing.role === "ADMIN") {
        await assignAdminIfNeeded(parsed.data.baid);
    }
    return res.json({ ok: true });
});
exports.customerInvitesRouter.post("/requests/list", async (req, res) => {
    const parsed = LIST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const access = await ensureAdmin(parsed.data.userId, parsed.data.baid);
    if (!access.ok)
        return res.status(access.status ?? 403).json({ message: "Not authorized" });
    const requests = await prisma.inviteRequestLog.findMany({
        where: { baid: parsed.data.baid },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    return res.json({ requests });
});
