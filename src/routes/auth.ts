import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { makeRandomToken, sha256 } from "../lib/tokens";
import { validatePasswordRules, hashPassword } from "../lib/passwords";
import { sendPasswordResetEmail } from "../lib/email";

const prisma = new PrismaClient();
export const authRouter = Router();

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Sends email with reset link (valid 1 hour)
 */
authRouter.post("/forgot-password", async (req, res) => {
  const body = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const email = body.data.email.toLowerCase();
  const user = await prisma.staffUser.findUnique({ where: { email } });

  // Always return 200 to avoid leaking which emails exist.
  if (!user || !user.isActive) return res.json({ ok: true });

  const rawToken = makeRandomToken(32);
  const tokenHash = sha256(rawToken);
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

  await sendPasswordResetEmail({ to: email, resetUrl });

  return res.json({ ok: true });
});

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 * Resets password using emailed token. Token valid 1 hour.
 * After reset: mustChangePassword = false
 */
authRouter.post("/reset-password", async (req, res) => {
  const body = z.object({
    token: z.string().min(10),
    newPassword: z.string().min(1)
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const rule = validatePasswordRules(body.data.newPassword);
  if (!rule.ok) return res.status(400).json({ message: rule.message });

  const tokenHash = sha256(body.data.token);

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

  const newHash = await hashPassword(body.data.newPassword);

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
