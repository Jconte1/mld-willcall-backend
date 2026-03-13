import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { makeRandomToken, sha256 } from "../lib/tokens";
import { hashPassword } from "../lib/passwords";
import { sendEmail } from "../notifications/providers/email/sendEmail";

const prisma = new PrismaClient();
export const authRouter = Router();

const FORGOT_RESPONSE = {
  ok: true,
  message: "If your email exists, you'll receive a reset link shortly.",
};

const FORGOT_BODY = z.object({
  email: z.string().email(),
  type: z.enum(["staff", "customer"]).optional(),
});
const RESET_BODY = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(1),
});

const THROTTLE_WINDOW_MS = 60 * 60 * 1000; // 1h
const THROTTLE_LOCK_MS = 20 * 60 * 1000; // 20m
const THROTTLE_EMAIL_LIMIT = 3;
const THROTTLE_IP_LIMIT = 10;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15m

function normalizeEmail(email: string) {
  return email.toLowerCase().trim();
}

function normalizeIp(raw: string) {
  return raw.trim().slice(0, 128);
}

function getRequestIp(req: any) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return normalizeIp(forwarded.split(",")[0] ?? "");
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return normalizeIp(realIp);
  }
  const fallback = req.ip || req.socket?.remoteAddress || "unknown";
  return normalizeIp(String(fallback));
}

function validateResetPasswordRules(pw: string): { ok: boolean; message?: string } {
  if (pw.length < 12) return { ok: false, message: "Password must be at least 12 characters." };
  if (!/[A-Z]/.test(pw)) return { ok: false, message: "Password must include at least 1 uppercase letter." };
  if (!/[a-z]/.test(pw)) return { ok: false, message: "Password must include at least 1 lowercase letter." };
  if (!/[0-9]/.test(pw)) return { ok: false, message: "Password must include at least 1 number." };
  if (!/[^A-Za-z0-9]/.test(pw)) return { ok: false, message: "Password must include at least 1 symbol." };

  const weak = ["password", "welcome", "changeme", "qwerty", "123456"];
  const lowered = pw.toLowerCase();
  if (weak.some((w) => lowered.includes(w))) {
    return { ok: false, message: "Password is too weak. Please choose a stronger password." };
  }

  return { ok: true };
}

async function incrementThrottle(key: string, limit: number) {
  const now = new Date();
  const current = await prisma.passwordResetThrottle.findUnique({ where: { key } });

  if (!current) {
    await prisma.passwordResetThrottle.create({
      data: { key, count: 1, windowStart: now },
    });
    return { blocked: false };
  }

  if (current.lockedUntil && current.lockedUntil > now) {
    return { blocked: true, lockedUntil: current.lockedUntil };
  }

  const sameWindow = now.getTime() - current.windowStart.getTime() < THROTTLE_WINDOW_MS;
  if (!sameWindow) {
    await prisma.passwordResetThrottle.update({
      where: { key },
      data: { count: 1, windowStart: now, lockedUntil: null },
    });
    return { blocked: false };
  }

  const nextCount = current.count + 1;
  const shouldLock = nextCount > limit;
  const lockedUntil = shouldLock ? new Date(now.getTime() + THROTTLE_LOCK_MS) : null;

  await prisma.passwordResetThrottle.update({
    where: { key },
    data: { count: nextCount, lockedUntil },
  });

  return { blocked: shouldLock, lockedUntil: lockedUntil ?? undefined };
}

async function sendPasswordResetGraphEmail(to: string, resetUrl: string) {
  const appName = process.env.APP_NAME ?? "MLD WillCall";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <h2 style="margin: 0 0 12px;">Reset your password</h2>
      <p style="margin: 0 0 12px;">A password reset was requested for your ${appName} account.</p>
      <p style="margin: 0 0 12px;">This link expires in <b>15 minutes</b>.</p>
      <p style="margin: 0 0 18px;">
        <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none;">
          Reset Password
        </a>
      </p>
      <p style="margin: 0; color: #555;">If you didn't request this, you can ignore this email.</p>
    </div>
  `;

  await sendEmail(
    to,
    `${appName} - Password Reset`,
    html,
    { allowTestOverride: true, allowNonProdSend: true }
  );
}

async function findValidResetRecord(token: string) {
  const tokenHash = sha256(token);
  return prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: {
      staffUser: true,
      user: { include: { customerCredential: true } },
    },
  });
}

authRouter.post("/forgot-password", async (req, res) => {
  const body = FORGOT_BODY.safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const email = normalizeEmail(body.data.email);
  const ip = getRequestIp(req);

  const [emailThrottle, ipThrottle] = await Promise.all([
    incrementThrottle(`email:${email}`, THROTTLE_EMAIL_LIMIT),
    incrementThrottle(`ip:${ip}`, THROTTLE_IP_LIMIT),
  ]);

  if (emailThrottle.blocked || ipThrottle.blocked) {
    console.warn("[auth][forgot-password] throttled", {
      email,
      ip,
      emailLockedUntil: emailThrottle.lockedUntil?.toISOString(),
      ipLockedUntil: ipThrottle.lockedUntil?.toISOString(),
    });
    return res.json(FORGOT_RESPONSE);
  }

  const requestedType = body.data.type ?? (email.endsWith("@mld.com") ? "staff" : "customer");
  const isStaffEmail = email.endsWith("@mld.com");
  const staff = requestedType === "staff" && isStaffEmail
    ? await prisma.staffUser.findUnique({ where: { email } })
    : null;

  const customer = requestedType === "customer"
    ? await prisma.users.findUnique({
      where: { email },
      include: { customerCredential: true },
    })
    : null;

  const targetStaff = staff && staff.isActive ? staff : null;
  const targetCustomer = customer?.customerCredential ? customer : null;

  // Always return 200 to avoid account enumeration.
  if (!targetStaff && !targetCustomer) {
    console.info("[auth][forgot-password] no matching user", { email, ip });
    return res.json(FORGOT_RESPONSE);
  }

  const rawToken = makeRandomToken(32);
  const tokenHash = sha256(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);

  await prisma.$transaction(async (tx) => {
    if (targetStaff) {
      await tx.passwordResetToken.updateMany({
        where: { staffUserId: targetStaff.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          staffUserId: targetStaff.id,
          principal: "STAFF",
          tokenHash,
          expiresAt,
        },
      });
      return;
    }

    await tx.passwordResetToken.updateMany({
      where: { userId: targetCustomer!.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.passwordResetToken.create({
      data: {
        userId: targetCustomer!.id,
        principal: "CUSTOMER",
        tokenHash,
        expiresAt,
      },
    });
  });

  const frontend = process.env.FRONTEND_URL ?? "https://mld-willcall.vercel.app";
  const resetType = targetStaff ? "staff" : "customer";
  const resetUrl = `${frontend.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(rawToken)}&type=${resetType}`;

  try {
    await sendPasswordResetGraphEmail(email, resetUrl);
    console.info("[auth][forgot-password] email sent", {
      email,
      ip,
      principal: targetStaff ? "STAFF" : "CUSTOMER",
    });
  } catch (err: any) {
    console.error("[auth][forgot-password] email send failed", {
      email,
      ip,
      error: err?.message ?? String(err),
    });
  }

  return res.json(FORGOT_RESPONSE);
});

/**
 * GET /api/auth/reset-password/validate?token=...
 * Validates reset token without consuming it.
 */
authRouter.get("/reset-password/validate", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) return res.status(400).json({ message: "Token is required" });

  const record = await findValidResetRecord(token);
  if (!record) return res.status(400).json({ message: "Invalid or expired token" });

  if (record.principal === "STAFF" && (!record.staffUser || !record.staffUser.isActive)) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  if (record.principal === "CUSTOMER" && (!record.user || !record.user.customerCredential)) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  return res.json({
    ok: true,
    expiresAt: record.expiresAt.toISOString(),
    type: record.principal === "STAFF" ? "staff" : "customer",
  });
});

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 * Resets password using emailed token. Token valid 15 minutes.
 */
authRouter.post("/reset-password", async (req, res) => {
  const body = RESET_BODY.safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const rule = validateResetPasswordRules(body.data.newPassword);
  if (!rule.ok) return res.status(400).json({ message: rule.message });

  const record = await findValidResetRecord(body.data.token);

  if (!record) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  if (record.principal === "STAFF" && (!record.staffUser || !record.staffUser.isActive)) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  if (record.principal === "CUSTOMER" && (!record.user || !record.user.customerCredential)) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  const newHash = await hashPassword(body.data.newPassword);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (record.principal === "STAFF") {
      await tx.staffUser.update({
        where: { id: record.staffUserId! },
        data: { passwordHash: newHash, mustChangePassword: false },
      });

      await tx.passwordResetToken.updateMany({
        where: { staffUserId: record.staffUserId!, usedAt: null },
        data: { usedAt: now },
      });
    } else {
      await tx.customerCredential.update({
        where: { userId: record.userId! },
        data: { passwordHash: newHash },
      });

      await tx.passwordResetToken.updateMany({
        where: { userId: record.userId!, usedAt: null },
        data: { usedAt: now },
      });
    }

    await tx.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: now },
    });
  });

  console.info("[auth][reset-password] success", {
    principal: record.principal,
    staffUserId: record.staffUserId ?? null,
    userId: record.userId ?? null,
  });

  return res.json({
    ok: true,
    type: record.principal === "STAFF" ? "staff" : "customer",
  });
});
