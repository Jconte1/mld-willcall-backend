import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import crypto from "node:crypto";

import { hashPassword, verifyPassword, validatePasswordRules } from "../lib/passwords";
import { verifyBaidInAcumatica } from "../lib/acumatica/verifyBaid";

const prisma = new PrismaClient();
export const customerAuthRouter = Router();

const BAID_REGEX = /^BA\d{7}$/;

const REGISTER_BODY = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 10, { message: "Enter a 10-digit phone number" }),
  baid: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
  zip: z
    .string()
    .transform((v) => v.replace(/\D/g, "").slice(0, 5))
    .refine((v) => /^\d{5}$/.test(v), { message: "ZIP must be 5 digits" }),
  inviteCode: z
    .string()
    .transform((v) => v.replace(/\s+/g, ""))
    .refine((v) => v.length >= 6, { message: "Invite code is required" }),
  password: z.string().min(1),
});

const VERIFY_BAID_BODY = z.object({
  baid: z
    .string()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .refine((v) => BAID_REGEX.test(v), { message: "BAID must be BA followed by 7 digits" }),
  zip: z
    .string()
    .transform((v) => v.replace(/\D/g, "").slice(0, 5))
    .refine((v) => /^\d{5}$/.test(v), { message: "ZIP must be 5 digits" }),
});

const LOGIN_BODY = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function msSince(t0: number) {
  return Date.now() - t0;
}

function hashInviteCode(code: string) {
  const secret = process.env.INVITE_CODE_SECRET || "";
  return crypto.createHash("sha256").update(`${code}:${secret}`).digest("hex");
}

/**
 * POST /api/customer/register
 * Body: { name, email, phone, baid, zip, inviteCode, password }
 * Returns: { user }
 */
customerAuthRouter.post("/register", async (req, res) => {
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
  const zip = parsed.data.zip;
  const inviteCode = parsed.data.inviteCode;

  console.log("[willcall][customer][register] start", {
    email,
    baid,
  });

  const rule = validatePasswordRules(parsed.data.password);
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

  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const verified = await verifyBaidInAcumatica(baid, zip);
    if (!verified) {
      console.warn("[willcall][customer][register] baid verification failed", {
        email,
        baid,
        ms: msSince(t0),
      });
      return res.status(400).json({
        message: "We couldn't confirm these details. Please contact your salesperson.",
      });
    }

    const now = new Date();
    const codeHash = hashInviteCode(inviteCode);
    const invite = await prisma.inviteCode.findFirst({
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
        ms: msSince(t0),
      });
      return res.status(400).json({
        message: "We couldn't confirm these details. Please contact your salesperson.",
      });
    }

    if (!process.env.NOTIFICATIONS_TEST_EMAIL && invite.recipientEmail) {
      const match = invite.recipientEmail.toLowerCase().trim() === email;
      if (!match) {
        console.warn("[willcall][customer][register] invite email mismatch", {
          email,
          baid,
          ms: msSince(t0),
        });
        return res.status(400).json({
          message: "We couldn't confirm these details. Please contact your salesperson.",
        });
      }
    }

    const adminCount = await prisma.accountUserRole.count({
      where: { baid, role: "ADMIN", isActive: true },
    });
    const assignedRole = adminCount > 0 ? invite.role : "ADMIN";

    const user = await prisma.$transaction(async (tx) => {
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

      await tx.accountUserRole.create({
        data: {
          id: crypto.randomUUID(),
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
  } catch (err: any) {
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
customerAuthRouter.post("/verify-baid", async (req, res) => {
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
    const exists = await verifyBaidInAcumatica(baid, zip);

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
  } catch (err: any) {
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
customerAuthRouter.post("/login", async (req, res) => {
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

  const ok = await verifyPassword(password, cred.passwordHash);
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

  const roles = await prisma.accountUserRole.findMany({
    where: { userId: user.id, isActive: true },
  });
  const accountRole =
    roles.find((r) => r.role === "ADMIN")?.role ??
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
