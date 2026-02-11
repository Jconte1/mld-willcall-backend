import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import crypto from "node:crypto";

import { verifyBaidInAcumatica } from "../lib/acumatica/verifyBaid";
import { sendEmail } from "../notifications/providers/email/sendEmail";
import { buildInviteEmail } from "../notifications/templates/email/buildInviteEmail";

const prisma = new PrismaClient();
export const internalInvitesRouter = Router();

const INTERNAL_TOKEN = process.env.INTERNAL_INVITE_TOKEN || "";
const BAID_REGEX = /^BA\d{7}$/;
const INVITE_EXPIRY_HOURS = 48;

const DISPATCH_BODY = z.object({
  customerId: z.string().min(1),
  billingZip: z.string().min(1),
  email: z.string().email(),
  sendEmail: z.boolean().optional(),
});

function hashInviteCode(code: string) {
  const secret = process.env.INVITE_CODE_SECRET || "";
  return crypto.createHash("sha256").update(`${code}:${secret}`).digest("hex");
}

function generateInviteCode() {
  const digits = crypto.randomInt(0, 999999);
  return String(digits).padStart(6, "0");
}

function normalizeBaid(value: string) {
  return value.replace(/\s+/g, "").toUpperCase();
}

function normalizeZip(value: string) {
  return value.replace(/\D/g, "").slice(0, 5);
}

function requireInternalAuth(req: any, res: any, next: any) {
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

internalInvitesRouter.post("/dispatch", requireInternalAuth, async (req, res) => {
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

  if (!BAID_REGEX.test(baid) || zip.length !== 5) {
    console.info("[internal-invites] invalid inputs", {
      hasBaid: Boolean(baid),
      hasZip: Boolean(zip),
      zipLen: zip.length,
    });
    return res.status(400).json({ message: "Invalid Customer ID# or ZIP" });
  }

  try {
    const verified = await verifyBaidInAcumatica(baid, zip);
    if (!verified) {
      console.info("[internal-invites] verify failed", { baid });
      return res.status(400).json({ message: "Invalid Customer ID# or ZIP" });
    }
  } catch (err: any) {
    console.info("[internal-invites] verify error", {
      baid,
      message: String(err?.message || err),
    });
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
    console.info("[internal-invites] issuing new code", { baid, hasExisting: Boolean(existing) });
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
    } else {
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
    const message = buildInviteEmail(code, baid, "Manager", frontendUrl, zip);
    await sendEmail(email, message.subject, message.body, {
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
