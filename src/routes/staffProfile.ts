import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";

const prisma = new PrismaClient();
export const staffProfileRouter = Router();

staffProfileRouter.use(requireAuth);

const profileSchema = z.object({
  salespersonNumber: z
    .string()
    .min(3)
    .max(5)
    .regex(/^\d+$/, "Salesperson number must be digits only"),
  salespersonName: z.string().min(1),
  salespersonPhone: z.string().optional(),
  salespersonEmail: z.string().email().optional(),
});

function normalizePhone(input?: string) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  return digits || null;
}

function normalizeSalespersonNumber(value?: string) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || null;
}

/**
 * GET /api/staff/profile
 * Returns salesperson profile for current user (SalesPerson only).
 */
staffProfileRouter.get("/", async (req, res) => {
  if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });
  if (req.auth.role !== "SALESPERSON" && req.auth.role !== "ADMIN") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const user = await prisma.staffUser.findUnique({
    where: { id: req.auth.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      salespersonNumber: true,
      salespersonName: true,
      salespersonPhone: true,
      salespersonEmail: true,
    },
  });

  if (!user) return res.status(404).json({ message: "Not found" });
  return res.json({ profile: user });
});

/**
 * PUT /api/staff/profile
 * Updates salesperson profile for current user.
 */
staffProfileRouter.put("/", async (req, res) => {
  if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });
  if (req.auth.role !== "SALESPERSON" && req.auth.role !== "ADMIN") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  const salespersonNumber = normalizeSalespersonNumber(parsed.data.salespersonNumber);
  if (!salespersonNumber) {
    return res.status(400).json({ message: "Salesperson number is required" });
  }

  const existing = await prisma.staffUser.findFirst({
    where: {
      salespersonNumber,
      id: { not: req.auth.id },
    },
    select: { id: true },
  });
  if (existing) {
    return res.status(400).json({ message: "Salesperson number already exists" });
  }

  const updated = await prisma.staffUser.update({
    where: { id: req.auth.id },
    data: {
      salespersonNumber,
      salespersonName: parsed.data.salespersonName,
      salespersonPhone: normalizePhone(parsed.data.salespersonPhone),
      salespersonEmail: parsed.data.salespersonEmail?.toLowerCase() ?? null,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      salespersonNumber: true,
      salespersonName: true,
      salespersonPhone: true,
      salespersonEmail: true,
    },
  });

  return res.json({ profile: updated });
});
