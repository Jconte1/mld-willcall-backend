"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.staffProfileRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const auth_1 = require("../middleware/auth");
const locationIds_1 = require("../lib/locationIds");
const prisma = new client_1.PrismaClient();
exports.staffProfileRouter = (0, express_1.Router)();
exports.staffProfileRouter.use(auth_1.requireAuth);
const profileSchema = zod_1.z.object({
    salespersonNumber: zod_1.z
        .string()
        .min(3)
        .max(5)
        .regex(/^\d+$/, "Salesperson number must be digits only"),
    salespersonName: zod_1.z.string().min(1),
    salespersonPhone: zod_1.z.string().optional(),
    salespersonEmail: zod_1.z.string().email().optional(),
});
function normalizePhone(input) {
    if (!input)
        return null;
    const digits = String(input).replace(/\D/g, "");
    return digits || null;
}
function normalizeSalespersonNumber(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits || null;
}
function isProfileComplete(user) {
    if (user.role !== "SALESPERSON")
        return true;
    return Boolean(user.salespersonNumber && user.salespersonName);
}
/**
 * GET /api/staff/profile
 * Returns salesperson profile for current user (SalesPerson only).
 */
exports.staffProfileRouter.get("/", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    if (req.auth.role !== "SALESPERSON" && req.auth.role !== "ADMIN") {
        return res.status(403).json({ message: "Forbidden" });
    }
    console.info("[staff-profile] get", {
        id: req.auth.id,
        email: req.auth.email,
        role: req.auth.role,
    });
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
    if (!user)
        return res.status(404).json({ message: "Not found" });
    return res.json({ profile: user });
});
/**
 * PUT /api/staff/profile
 * Updates salesperson profile for current user.
 */
exports.staffProfileRouter.put("/", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    if (req.auth.role !== "SALESPERSON" && req.auth.role !== "ADMIN") {
        return res.status(403).json({ message: "Forbidden" });
    }
    console.info("[staff-profile] put", {
        id: req.auth.id,
        email: req.auth.email,
        role: req.auth.role,
    });
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    const salespersonNumber = normalizeSalespersonNumber(parsed.data.salespersonNumber);
    if (!salespersonNumber) {
        return res.status(400).json({ message: "Salesperson number is required" });
    }
    const idLookup = await prisma.staffUser.findUnique({
        where: { id: req.auth.id },
        select: { id: true, email: true, role: true },
    });
    const emailLookup = await prisma.staffUser.findUnique({
        where: { email: req.auth.email },
        select: { id: true, email: true, role: true },
    });
    console.info("[staff-profile] lookup", {
        byId: idLookup,
        byEmail: emailLookup,
    });
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
    let updated = null;
    try {
        updated = await prisma.staffUser.update({
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
                locationAccess: true,
                mustChangePassword: true,
                salespersonNumber: true,
                salespersonName: true,
                salespersonPhone: true,
                salespersonEmail: true,
            },
        });
    }
    catch (err) {
        console.warn("[staff-profile] update by id failed", {
            id: req.auth.id,
            email: req.auth.email,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    if (!updated) {
        const fallback = await prisma.staffUser.findUnique({
            where: { email: req.auth.email },
            select: { id: true },
        });
        if (!fallback) {
            return res.status(404).json({ message: "Staff user not found" });
        }
        updated = await prisma.staffUser.update({
            where: { id: fallback.id },
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
                locationAccess: true,
                mustChangePassword: true,
                salespersonNumber: true,
                salespersonName: true,
                salespersonPhone: true,
                salespersonEmail: true,
            },
        });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret)
        return res.status(500).json({ message: "Server misconfigured: JWT_SECRET missing" });
    const normalizedLocationAccess = (0, locationIds_1.normalizeLocationIds)(updated.locationAccess ?? []);
    const mustCompleteProfile = !isProfileComplete(updated);
    const token = jsonwebtoken_1.default.sign({
        email: updated.email,
        role: updated.role,
        locationAccess: normalizedLocationAccess,
        mustChangePassword: updated.mustChangePassword,
        mustCompleteProfile,
    }, secret, {
        subject: updated.id,
        expiresIn: "7d",
    });
    return res.json({ profile: updated, token });
});
