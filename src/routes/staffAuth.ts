import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { verifyPassword, validatePasswordRules, hashPassword } from "../lib/passwords";

function logInstance(label: string) {
  const raw = process.env.DATABASE_URL || "";
  let safeDb = "unknown";
  try {
    const url = new URL(raw);
    safeDb = `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname ? url.pathname : ""}`;
  } catch {
    safeDb = "unknown";
  }
  console.info(`[staffAuth/${label}] instance`, {
    pid: process.pid,
    db: safeDb,
    host: process.env.HOST || "",
    port: process.env.PORT || "",
  });
}
import { normalizeLocationIds } from "../lib/locationIds";
import { requireAuth } from "../middleware/auth";

const prisma = new PrismaClient();
export const staffAuthRouter = Router();

const LOGIN_BODY = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

function isSalespersonProfileComplete(user: {
  role: string;
  salespersonNumber?: string | null;
  salespersonName?: string | null;
}) {
  if (user.role !== "SALESPERSON") return true;
  return Boolean(user.salespersonNumber && user.salespersonName);
}

/**
 * POST /api/staff/login
 * Body: { email, password }
 * Returns: { token, user }
 *
 * Intended to be used by NextAuth Credentials authorize() on the frontend.
 */
staffAuthRouter.post("/login", async (req, res) => {
  logInstance("login");
  const parsed = LOGIN_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  const email = parsed.data.email.toLowerCase();
  if (!email.endsWith("@mld.com")) return res.status(401).json({ message: "Invalid credentials" });

  const user = await prisma.staffUser.findUnique({ where: { email } });
  if (!user || !user.isActive) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ message: "Server misconfigured: JWT_SECRET missing" });

  const normalizedLocationAccess = normalizeLocationIds(user.locationAccess ?? []);

  console.info("[staffAuth/login] user resolved", {
    id: user.id,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  });

  const token = jwt.sign(
    {
      email: user.email,
      role: user.role,
      locationAccess: normalizedLocationAccess,
      mustChangePassword: user.mustChangePassword,
      mustCompleteProfile: !isSalespersonProfileComplete(user)
    },
    secret,
    {
      subject: user.id,
      expiresIn: "7d"
    }
  );

  console.info("[staffAuth/login] token issued", {
    sub: user.id,
    email: user.email,
    role: user.role,
    mustCompleteProfile: !isSalespersonProfileComplete(user),
  });

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      locationAccess: normalizedLocationAccess,
      mustChangePassword: user.mustChangePassword,
      mustCompleteProfile: !isSalespersonProfileComplete(user),
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
staffAuthRouter.post("/change-password", requireAuth, async (req, res) => {
  logInstance("change-password");
  console.info("[staffAuth/change-password] auth", {
    hasAuth: Boolean(req.auth),
    id: req.auth?.id,
    email: req.auth?.email,
    role: req.auth?.role,
  });
  const body = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1)
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const user = await prisma.staffUser.findUnique({ where: { id: req.auth!.id } });
  console.info("[staffAuth/change-password] user lookup", {
    found: Boolean(user),
    id: user?.id,
    email: user?.email,
    isActive: user?.isActive,
  });
  if (!user || !user.isActive) return res.status(401).json({ message: "Unauthorized" });

  const ok = await verifyPassword(body.data.currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ message: "Current password is incorrect" });

  const rule = validatePasswordRules(body.data.newPassword);
  if (!rule.ok) return res.status(400).json({ message: rule.message });

  const newHash = await hashPassword(body.data.newPassword);

  await prisma.staffUser.update({
    where: { id: user.id },
    data: { passwordHash: newHash, mustChangePassword: false }
  });

  console.info("[staffAuth/change-password] success", {
    staffUserId: user.id,
    email: user.email
  });

  return res.json({ ok: true });
});
