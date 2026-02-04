import { Router } from "express";
import { PrismaClient, StaffRole } from "@prisma/client";
import { z } from "zod";
import { generateTempPassword, hashPassword } from "../lib/passwords";
import { normalizeLocationIds } from "../lib/locationIds";
import { requireAuth, requireRole } from "../middleware/auth";
import { sendEmail } from "../notifications/providers/email/sendEmail";
import { buildStaffOnboardingEmail } from "../notifications/templates/email/buildStaffOnboardingEmail";

const prisma = new PrismaClient();
export const staffUsersRouter = Router();

staffUsersRouter.use(requireAuth);
staffUsersRouter.use(requireRole("ADMIN"));

const LOCS = z.array(z.enum(["slc-hq", "slc-outlet", "boise-willcall"]));
const SALES_NUMBER = z
  .string()
  .min(3)
  .max(5)
  .regex(/^\d+$/, "Salesperson number must be digits only");

function normalizeSalespersonNumber(value: string | undefined | null) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits : null;
}

/**
 * GET /api/staff/users
 */
staffUsersRouter.get("/", async (_req, res) => {
  const users = await prisma.staffUser.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      locationAccess: true,
      isActive: true,
      mustChangePassword: true,
      salespersonNumber: true,
      salespersonName: true,
      salespersonPhone: true,
      salespersonEmail: true,
      createdAt: true,
      updatedAt: true
    }
  });

  const normalized = users.map((user: (typeof users)[number]) => ({
    ...user,
    locationAccess: normalizeLocationIds(user.locationAccess ?? []),
  }));

  return res.json({ users: normalized });
});

/**
 * POST /api/staff/users
 * Creates staff user with generated temp password + mustChangePassword=true
 * Returns tempPassword so admin can email it.
 */
staffUsersRouter.post("/", async (req, res) => {
  const body = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    role: z.enum(["ADMIN", "STAFF", "VIEWER", "SALESPERSON"]).default("STAFF"),
    salespersonNumber: SALES_NUMBER.optional(),
    salespersonName: z.string().min(1).optional(),
    salespersonPhone: z.string().optional(),
    salespersonEmail: z.string().email().optional(),
    locationAccess: LOCS.default(["slc-hq"])
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  console.log("[staff-users] create request", {
    email: body.data.email,
    role: body.data.role,
    locationAccess: body.data.locationAccess,
  });

  const email = body.data.email.toLowerCase();
  if (!email.endsWith("@mld.com")) return res.status(400).json({ message: "Email must end with @mld.com" });

  const salespersonNumber = normalizeSalespersonNumber(body.data.salespersonNumber);
  if (salespersonNumber) {
    const existingSalesperson = await prisma.staffUser.findFirst({
      where: { salespersonNumber },
      select: { id: true },
    });
    if (existingSalesperson) {
      return res.status(400).json({ message: "Salesperson number already exists" });
    }
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const created = await prisma.staffUser.create({
    data: {
      email,
      name: body.data.name,
      role:
        body.data.role === "ADMIN"
          ? StaffRole.ADMIN
          : body.data.role === "VIEWER"
            ? StaffRole.VIEWER
            : body.data.role === "SALESPERSON"
              ? StaffRole.SALESPERSON
              : StaffRole.STAFF,
      locationAccess:
        body.data.role === "ADMIN"
          ? ["slc-hq", "slc-outlet", "boise-willcall"]
          : body.data.locationAccess,
      salespersonNumber,
      salespersonName: body.data.salespersonName ?? null,
      salespersonPhone: body.data.salespersonPhone
        ? body.data.salespersonPhone.replace(/\D/g, "")
        : null,
      salespersonEmail: body.data.salespersonEmail?.toLowerCase() ?? null,
      passwordHash,
      isActive: true,
      mustChangePassword: true
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      locationAccess: true,
      isActive: true,
      mustChangePassword: true,
      salespersonNumber: true,
      salespersonName: true,
      salespersonPhone: true,
      salespersonEmail: true,
      createdAt: true,
      updatedAt: true
    }
  });

  console.log("[staff-users] created", {
    id: created.id,
    email: created.email,
    role: created.role,
    locationAccess: created.locationAccess,
  });

  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  if (!frontendUrl) {
    return res.status(500).json({ message: "Server misconfigured: FRONTEND_URL missing" });
  }

  const loginUrl = `${frontendUrl}/staff`;
  const message = buildStaffOnboardingEmail(created.name, loginUrl, tempPassword);

  try {
    await sendEmail(created.email, message.subject, message.body, {
      allowTestOverride: false,
      allowNonProdSend: true,
    });
  } catch (err) {
    console.error("[staff-users] onboarding email failed", err);
    return res.status(200).json({
      user: {
        ...created,
        locationAccess: normalizeLocationIds(created.locationAccess ?? []),
      },
      emailSent: false,
      message: "User created but onboarding email failed to send.",
    });
  }

  return res.status(201).json({
    user: {
      ...created,
      locationAccess: normalizeLocationIds(created.locationAccess ?? []),
    },
    emailSent: true,
  });
});

/**
 * GET /api/staff/users/:id
 */
staffUsersRouter.get("/:id", async (req, res) => {
  const user = await prisma.staffUser.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      locationAccess: true,
      isActive: true,
      mustChangePassword: true,
      salespersonNumber: true,
      salespersonName: true,
      salespersonPhone: true,
      salespersonEmail: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (!user) return res.status(404).json({ message: "Not found" });
  return res.json({
    user: {
      ...user,
      locationAccess: normalizeLocationIds(user.locationAccess ?? []),
    },
  });
});

/**
 * PATCH /api/staff/users/:id
 * Edit user and/or disable. Admin role always gets all locations.
 */
staffUsersRouter.patch("/:id", async (req, res) => {
  const body = z.object({
    email: z.string().email().optional(),
    name: z.string().min(1).optional(),
    role: z.enum(["ADMIN", "STAFF", "VIEWER", "SALESPERSON"]).optional(),
    locationAccess: LOCS.optional(),
    isActive: z.boolean().optional(),
    mustChangePassword: z.boolean().optional(),
    salespersonNumber: SALES_NUMBER.optional(),
    salespersonName: z.string().min(1).optional(),
    salespersonPhone: z.string().optional(),
    salespersonEmail: z.string().email().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  console.log("[staff-users] update request", {
    id: req.params.id,
    role: body.data.role,
    locationAccess: body.data.locationAccess,
    isActive: body.data.isActive,
  });

  const existing = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Not found" });

  const nextRole = body.data.role ?? existing.role;
  const nextSalespersonNumber =
    body.data.salespersonNumber != null
      ? normalizeSalespersonNumber(body.data.salespersonNumber)
      : existing.salespersonNumber;

  const nextEmail = body.data.email ? body.data.email.toLowerCase() : undefined;
  if (nextEmail && !nextEmail.endsWith("@mld.com")) {
    return res.status(400).json({ message: "Email must end with @mld.com" });
  }

  if (nextSalespersonNumber && nextSalespersonNumber !== existing.salespersonNumber) {
    const existingSalesperson = await prisma.staffUser.findFirst({
      where: { salespersonNumber: nextSalespersonNumber, id: { not: existing.id } },
      select: { id: true },
    });
    if (existingSalesperson) {
      return res.status(400).json({ message: "Salesperson number already exists" });
    }
  }

  const updated = await prisma.staffUser.update({
    where: { id: req.params.id },
    data: {
      email: nextEmail,
      name: body.data.name,
      role:
        nextRole === "ADMIN"
          ? StaffRole.ADMIN
          : nextRole === "VIEWER"
            ? StaffRole.VIEWER
            : nextRole === "SALESPERSON"
              ? StaffRole.SALESPERSON
              : StaffRole.STAFF,
      locationAccess:
        nextRole === "ADMIN"
          ? ["slc-hq", "slc-outlet", "boise-willcall"]
          : (body.data.locationAccess ?? existing.locationAccess),
      isActive: body.data.isActive,
      mustChangePassword: body.data.mustChangePassword,
      salespersonNumber: nextSalespersonNumber ?? null,
      salespersonName: body.data.salespersonName ?? existing.salespersonName ?? null,
      salespersonPhone: body.data.salespersonPhone
        ? body.data.salespersonPhone.replace(/\D/g, "")
        : existing.salespersonPhone ?? null,
      salespersonEmail: body.data.salespersonEmail
        ? body.data.salespersonEmail.toLowerCase()
        : existing.salespersonEmail ?? null,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      locationAccess: true,
      isActive: true,
      mustChangePassword: true,
      salespersonNumber: true,
      salespersonName: true,
      salespersonPhone: true,
      salespersonEmail: true,
      createdAt: true,
      updatedAt: true
    }
  });

  console.log("[staff-users] updated", {
    id: updated.id,
    role: updated.role,
    locationAccess: updated.locationAccess,
    isActive: updated.isActive,
  });

  return res.json({
    user: {
      ...updated,
      locationAccess: normalizeLocationIds(updated.locationAccess ?? []),
    },
  });
});

/**
 * DELETE /api/staff/users/:id
 */
staffUsersRouter.delete("/:id", async (req, res) => {
  const existing = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Not found" });

  await prisma.staffUser.delete({ where: { id: req.params.id } });
  return res.json({ ok: true });
});
