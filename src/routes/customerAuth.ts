import { Router } from "express";
import { prisma } from "../lib/prisma";

import { z } from "zod";
import crypto from "node:crypto";

import { hashPassword, verifyPassword, validatePasswordRules } from "../lib/passwords";
import { verifyBaidInAcumatica } from "../lib/acumatica/verifyBaid";
import { clearFailedLogin, getLoginThrottleState, recordFailedLogin } from "../lib/loginThrottle";
import { verifyRegistrationPrefillToken } from "../lib/registrationPrefillToken";

export const customerAuthRouter = Router();

const REGISTER_REASON = {
  InvalidBody: "INVALID_REQUEST_BODY",
  PasswordTooShort: "PASSWORD_TOO_SHORT",
  PasswordNumberRequired: "PASSWORD_NUMBER_REQUIRED",
  PasswordSymbolRequired: "PASSWORD_SYMBOL_REQUIRED",
  EmailAlreadyExists: "EMAIL_ALREADY_EXISTS",
  DetailsNotConfirmed: "DETAILS_NOT_CONFIRMED",
  RegisterFailed: "REGISTER_FAILED",
} as const;

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

const REGISTER_PREFILL_BODY = z.object({
  token: z.string().min(20),
});

const AUTO_REGISTER_PREFILL_BODY = z.object({
  token: z.string().min(20),
});

const COMPLETE_SETUP_BODY = z.object({
  userId: z.string().min(1),
  name: z.string().min(2),
  password: z.string().min(1),
});

function msSince(t0: number) {
  return Date.now() - t0;
}

function hashInviteCode(code: string) {
  const secret = process.env.INVITE_CODE_SECRET || "";
  return crypto.createHash("sha256").update(`${code}:${secret}`).digest("hex");
}

function generateTempPassword() {
  const raw = crypto.randomBytes(18).toString("base64url");
  // Ensure all customer password rules are met.
  return `Tmp!${raw}9`;
}

/**
 * POST /api/customer/register/prefill
 * Body: { token }
 * Returns: { baid, zip, inviteCode, email, orderNbr }
 */
customerAuthRouter.post("/register/prefill", async (req, res) => {
  const parsed = REGISTER_PREFILL_BODY.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  try {
    const prefill = verifyRegistrationPrefillToken(parsed.data.token);
    const existing = prefill.email
      ? await prisma.users.findUnique({
          where: { email: prefill.email.toLowerCase().trim() },
          select: { id: true },
        })
      : null;
    return res.json({
      baid: prefill.baid,
      zip: prefill.zip,
      inviteCode: prefill.inviteCode,
      email: prefill.email,
      orderNbr: prefill.orderNbr,
      existingAccount: Boolean(existing),
    });
  } catch {
    return res.status(400).json({ message: "Invalid or expired link" });
  }
});

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
      reasonCode: REGISTER_REASON.InvalidBody,
      issues: parsed.error.issues,
      ms: msSince(t0),
    });
    return res.status(400).json({
      message: "Invalid request body",
      reasonCode: REGISTER_REASON.InvalidBody,
    });
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
    const reasonCode =
      rule.message === "Password must be at least 8 characters."
        ? REGISTER_REASON.PasswordTooShort
        : rule.message === "Password must include at least 1 number."
          ? REGISTER_REASON.PasswordNumberRequired
          : REGISTER_REASON.PasswordSymbolRequired;
    console.warn("[willcall][customer][register] password rules failed", {
      email,
      baid,
      reasonCode,
      reason: rule.message,
      ms: msSince(t0),
    });
    return res.status(400).json({ message: rule.message, reasonCode });
  }

  const existing = await prisma.users.findUnique({ where: { email } });
  if (existing) {
    console.warn("[willcall][customer][register] email already exists", {
      email,
      userId: existing.id,
      reasonCode: REGISTER_REASON.EmailAlreadyExists,
      ms: msSince(t0),
    });
    return res.status(409).json({
      message: "An account with that email already exists",
      reasonCode: REGISTER_REASON.EmailAlreadyExists,
    });
  }

  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const verified = await verifyBaidInAcumatica(baid, zip);
    if (!verified) {
      console.warn("[willcall][customer][register] baid verification failed", {
        email,
        baid,
        reasonCode: REGISTER_REASON.DetailsNotConfirmed,
        ms: msSince(t0),
      });
      return res.status(400).json({
        message: "We couldn't confirm these details. Please contact your salesperson.",
        reasonCode: REGISTER_REASON.DetailsNotConfirmed,
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
        reasonCode: REGISTER_REASON.DetailsNotConfirmed,
        ms: msSince(t0),
      });
      return res.status(400).json({
        message: "We couldn't confirm these details. Please contact your salesperson.",
        reasonCode: REGISTER_REASON.DetailsNotConfirmed,
      });
    }

    if (!process.env.NOTIFICATIONS_TEST_EMAIL && invite.recipientEmail) {
      const match = invite.recipientEmail.toLowerCase().trim() === email;
      if (!match) {
        console.warn("[willcall][customer][register] invite email mismatch", {
          email,
          baid,
          reasonCode: REGISTER_REASON.DetailsNotConfirmed,
          ms: msSince(t0),
        });
        return res.status(400).json({
          message: "We couldn't confirm these details. Please contact your salesperson.",
          reasonCode: REGISTER_REASON.DetailsNotConfirmed,
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
      reasonCode: "REGISTER_SUCCESS",
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
      reasonCode: REGISTER_REASON.RegisterFailed,
      ms: msSince(t0),
      error: err?.message ?? String(err),
    });
    return res.status(500).json({
      message: "Failed to register",
      reasonCode: REGISTER_REASON.RegisterFailed,
    });
  }
});

/**
 * POST /api/customer/auto-register-from-prefill
 * Body: { token }
 * Returns: { email, password, userId, created, baid, mustChangePassword, mustCompleteProfile }
 */
customerAuthRouter.post("/auto-register-from-prefill", async (req, res) => {
  const t0 = Date.now();
  const parsed = AUTO_REGISTER_PREFILL_BODY.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  let phase = "parse-token";
  let prefill: {
    baid: string;
    zip: string;
    inviteCode: string;
    email: string | null;
    orderNbr: string | null;
  };
  try {
    prefill = verifyRegistrationPrefillToken(parsed.data.token);
  } catch {
    return res.status(400).json({ message: "Invalid or expired link" });
  }

  const email = String(prefill.email || "").toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ message: "Invite is missing an email." });
  }

  const baid = prefill.baid;
  const zip = prefill.zip;
  const inviteCode = prefill.inviteCode;

  try {
    phase = "lookup-existing-user";
    const existingByEmail = await prisma.users.findUnique({
      where: { email },
      include: { customerCredential: true },
    });

    if (
      existingByEmail &&
      existingByEmail.customerCredential &&
      existingByEmail.baid?.toUpperCase() === baid &&
      !existingByEmail.mustChangePassword &&
      !existingByEmail.mustCompleteProfile
    ) {
      console.info("[willcall][customer][auto-register] existing-ready-account", {
        email,
        baid,
      });
      return res.status(409).json({
        message: "Your account is already set up. Please sign in.",
        reasonCode: REGISTER_REASON.EmailAlreadyExists,
        email,
      });
    }

    phase = "lookup-existing-user-repeat";
    const existing = await prisma.users.findUnique({
      where: { email },
      include: { customerCredential: true },
    });

    if (
      existing &&
      existing.customerCredential &&
      existing.baid?.toUpperCase() === baid &&
      !existing.mustChangePassword &&
      !existing.mustCompleteProfile
    ) {
      return res.status(409).json({
        message: "Your account is already set up. Please sign in.",
        reasonCode: REGISTER_REASON.EmailAlreadyExists,
        email,
      });
    }

    phase = "verify-baid";
    let verified = false;
    try {
      verified = await verifyBaidInAcumatica(baid, zip);
    } catch (err: any) {
      console.error("[willcall][customer][auto-register] verify-baid error", {
        email,
        baid,
        ms: msSince(t0),
        errorName: err?.name,
        error: err?.message ?? String(err),
      });
      return res.status(503).json({
        message: "Unable to verify account details right now. Please try again in a few minutes.",
        reasonCode: REGISTER_REASON.RegisterFailed,
      });
    }
    if (!verified) {
      console.info("[willcall][customer][auto-register] verify failed", {
        email,
        baid,
        zip,
      });
      return res.status(400).json({
        message: "We couldn't confirm these details. Please contact your salesperson.",
        reasonCode: REGISTER_REASON.DetailsNotConfirmed,
      });
    }

    const now = new Date();
    phase = "invite-lookup";
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
      if (
        existingByEmail &&
        existingByEmail.customerCredential &&
        existingByEmail.baid?.toUpperCase() === baid &&
        !existingByEmail.mustChangePassword &&
        !existingByEmail.mustCompleteProfile
      ) {
        console.info("[willcall][customer][auto-register] invite-missing-existing-ready", {
          email,
          baid,
        });
        return res.status(409).json({
          message: "Your account is already set up. Please sign in.",
          reasonCode: REGISTER_REASON.EmailAlreadyExists,
          email,
        });
      }

      console.info("[willcall][customer][auto-register] invite lookup failed", {
        email,
        baid,
        hasCodeHash: Boolean(codeHash),
      });
      return res.status(400).json({
        message: "We couldn't confirm these details. Please contact your salesperson.",
        reasonCode: REGISTER_REASON.DetailsNotConfirmed,
      });
    }

    phase = "invite-email-check";
    if (!process.env.NOTIFICATIONS_TEST_EMAIL && invite.recipientEmail) {
      const match = invite.recipientEmail.toLowerCase().trim() === email;
      if (!match) {
        console.info("[willcall][customer][auto-register] invite email mismatch", {
          baid,
          tokenEmail: email,
          inviteEmail: invite.recipientEmail.toLowerCase().trim(),
        });
        return res.status(400).json({
          message: "We couldn't confirm these details. Please contact your salesperson.",
          reasonCode: REGISTER_REASON.DetailsNotConfirmed,
        });
      }
    }

    phase = "hash-temp-password";
    const tempPassword = generateTempPassword();
    const tempHash = await hashPassword(tempPassword);

    if (existing) {
      phase = "prepare-existing-account";
      await prisma.$transaction(async (tx) => {
        if (!existing.customerCredential) {
          await tx.customerCredential.create({
            data: {
              userId: existing.id,
              passwordHash: tempHash,
              phone: "0000000000",
            },
          });
        } else {
          await tx.customerCredential.update({
            where: { userId: existing.id },
            data: { passwordHash: tempHash },
          });
        }

        await tx.users.update({
          where: { id: existing.id },
          data: {
            baid,
            mustChangePassword: true,
            mustCompleteProfile: true,
          },
        });
      });

      console.log("[willcall][customer][auto-register] existing account prepared", {
        userId: existing.id,
        email,
        baid,
        ms: msSince(t0),
      });

      return res.json({
        userId: existing.id,
        email,
        password: tempPassword,
        baid,
        created: false,
        mustChangePassword: true,
        mustCompleteProfile: true,
      });
    }

    phase = "determine-role";
    const adminCount = await prisma.accountUserRole.count({
      where: { baid, role: "ADMIN", isActive: true },
    });
    const assignedRole = adminCount > 0 ? invite.role : "ADMIN";

    phase = "create-account";
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.users.create({
        data: {
          id: crypto.randomUUID(),
          name: "Complete Profile",
          email,
          baid,
          emailVerified: false,
          updatedAt: now,
          mustChangePassword: true,
          mustCompleteProfile: true,
        },
      });

      await tx.customerCredential.create({
        data: {
          userId: created.id,
          passwordHash: tempHash,
          phone: "0000000000",
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

    console.log("[willcall][customer][auto-register] created", {
      userId: user.id,
      email,
      baid,
      ms: msSince(t0),
    });

    return res.json({
      userId: user.id,
      email,
      password: tempPassword,
      baid,
      created: true,
      mustChangePassword: true,
      mustCompleteProfile: true,
    });
  } catch (err: any) {
    console.error("[willcall][customer][auto-register] error", {
      phase,
      email,
      baid,
      ms: msSince(t0),
      errorName: err?.name,
      errorCode: err?.code,
      error: err?.message ?? String(err),
    });
    return res.status(500).json({ message: "Failed to complete account setup." });
  }
});

/**
 * POST /api/customer/complete-setup
 * Body: { userId, name, password }
 */
customerAuthRouter.post("/complete-setup", async (req, res) => {
  const parsed = COMPLETE_SETUP_BODY.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const userId = parsed.data.userId;
  const name = parsed.data.name.trim();
  const passwordRule = validatePasswordRules(parsed.data.password);
  if (!passwordRule.ok) {
    return res.status(400).json({ message: passwordRule.message });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const existing = await prisma.users.findUnique({
    where: { id: userId },
    include: { customerCredential: true },
  });
  if (!existing) {
    return res.status(404).json({ message: "User not found" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.users.update({
      where: { id: userId },
      data: {
        name,
        mustChangePassword: false,
        mustCompleteProfile: false,
      },
    });

    if (existing.customerCredential) {
      await tx.customerCredential.update({
        where: { userId },
        data: { passwordHash },
      });
    } else {
      await tx.customerCredential.create({
        data: {
          userId,
          passwordHash,
          phone: "0000000000",
        },
      });
    }
  });

  return res.json({ ok: true });
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

  const throttle = await getLoginThrottleState("customer", email);
  if (throttle.blocked) {
    return res.status(429).json({
      message: "Too many failed attempts. Account temporarily locked.",
      attemptsLeft: 0,
      lockedUntil: throttle.lockedUntil?.toISOString(),
    });
  }

  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    const failed = await recordFailedLogin("customer", email);
    console.warn("[willcall][customer][login] invalid credentials (no user)", {
      email,
      attemptsLeft: failed.attemptsLeft,
      ms: msSince(t0),
    });
    if (failed.blocked) {
      return res.status(429).json({
        message: "Too many failed attempts. Account temporarily locked.",
        attemptsLeft: 0,
        lockedUntil: failed.lockedUntil?.toISOString(),
      });
    }
    return res.status(401).json({
      message: `Invalid credentials. ${failed.attemptsLeft} attempts left.`,
      attemptsLeft: failed.attemptsLeft,
    });
  }

  const cred = await prisma.customerCredential.findUnique({ where: { userId: user.id } });
  if (!cred) {
    const failed = await recordFailedLogin("customer", email);
    console.warn("[willcall][customer][login] invalid credentials (no cred)", {
      email,
      userId: user.id,
      attemptsLeft: failed.attemptsLeft,
      ms: msSince(t0),
    });
    if (failed.blocked) {
      return res.status(429).json({
        message: "Too many failed attempts. Account temporarily locked.",
        attemptsLeft: 0,
        lockedUntil: failed.lockedUntil?.toISOString(),
      });
    }
    return res.status(401).json({
      message: `Invalid credentials. ${failed.attemptsLeft} attempts left.`,
      attemptsLeft: failed.attemptsLeft,
    });
  }

  const ok = await verifyPassword(password, cred.passwordHash);
  if (!ok) {
    const failed = await recordFailedLogin("customer", email);
    console.warn("[willcall][customer][login] invalid credentials (bad password)", {
      email,
      userId: user.id,
      attemptsLeft: failed.attemptsLeft,
      ms: msSince(t0),
    });
    if (failed.blocked) {
      return res.status(429).json({
        message: "Too many failed attempts. Account temporarily locked.",
        attemptsLeft: 0,
        lockedUntil: failed.lockedUntil?.toISOString(),
      });
    }
    return res.status(401).json({
      message: `Invalid credentials. ${failed.attemptsLeft} attempts left.`,
      attemptsLeft: failed.attemptsLeft,
    });
  }

  await clearFailedLogin("customer", email);

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
      mustChangePassword: Boolean(user.mustChangePassword),
      mustCompleteProfile: Boolean(user.mustCompleteProfile),
    },
  });
});
