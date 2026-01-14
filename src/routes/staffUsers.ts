import { Router } from "express";
import { PrismaClient, StaffRole } from "@prisma/client";
import { z } from "zod";
import { generateTempPassword, hashPassword } from "../lib/passwords";
import { normalizeLocationIds } from "../lib/locationIds";
import { requireAuth, requireRole } from "../middleware/auth";

const prisma = new PrismaClient();
export const staffUsersRouter = Router();

staffUsersRouter.use(requireAuth);
staffUsersRouter.use(requireRole("ADMIN"));

const LOCS = z.array(z.enum(["slc-hq", "slc-outlet", "boise-willcall"]));

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
      createdAt: true,
      updatedAt: true
    }
  });

  const normalized = users.map((user) => ({
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
    role: z.enum(["ADMIN", "STAFF"]).default("STAFF"),
      locationAccess: LOCS.default(["slc-hq"])
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const email = body.data.email.toLowerCase();
  if (!email.endsWith("@mld.com")) return res.status(400).json({ message: "Email must end with @mld.com" });

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const created = await prisma.staffUser.create({
    data: {
      email,
      name: body.data.name,
      role: body.data.role === "ADMIN" ? StaffRole.ADMIN : StaffRole.STAFF,
      locationAccess:
        body.data.role === "ADMIN"
          ? ["slc-hq", "slc-outlet", "boise-willcall"]
          : body.data.locationAccess,
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
      createdAt: true,
      updatedAt: true
    }
  });

  return res.status(201).json({
    user: {
      ...created,
      locationAccess: normalizeLocationIds(created.locationAccess ?? []),
    },
    tempPassword,
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
    role: z.enum(["ADMIN", "STAFF"]).optional(),
    locationAccess: LOCS.optional(),
    isActive: z.boolean().optional(),
    mustChangePassword: z.boolean().optional()
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const existing = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Not found" });

  const nextRole = body.data.role ?? existing.role;

  const nextEmail = body.data.email ? body.data.email.toLowerCase() : undefined;
  if (nextEmail && !nextEmail.endsWith("@mld.com")) {
    return res.status(400).json({ message: "Email must end with @mld.com" });
  }

  const updated = await prisma.staffUser.update({
    where: { id: req.params.id },
    data: {
      email: nextEmail,
      name: body.data.name,
      role: nextRole === "ADMIN" ? StaffRole.ADMIN : StaffRole.STAFF,
      locationAccess:
        nextRole === "ADMIN"
          ? ["slc-hq", "slc-outlet", "boise-willcall"]
          : (body.data.locationAccess ?? existing.locationAccess),
      isActive: body.data.isActive,
      mustChangePassword: body.data.mustChangePassword
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      locationAccess: true,
      isActive: true,
      mustChangePassword: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return res.json({
    user: {
      ...updated,
      locationAccess: normalizeLocationIds(updated.locationAccess ?? []),
    },
  });
});
