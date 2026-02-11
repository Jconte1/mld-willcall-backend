"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.staffUsersRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const passwords_1 = require("../lib/passwords");
const locationIds_1 = require("../lib/locationIds");
const auth_1 = require("../middleware/auth");
const sendEmail_1 = require("../notifications/providers/email/sendEmail");
const buildStaffOnboardingEmail_1 = require("../notifications/templates/email/buildStaffOnboardingEmail");
const prisma = new client_1.PrismaClient();
exports.staffUsersRouter = (0, express_1.Router)();
exports.staffUsersRouter.use(auth_1.requireAuth);
exports.staffUsersRouter.use((0, auth_1.requireRole)("ADMIN"));
const LOCS = zod_1.z.array(zod_1.z.enum(["slc-hq", "slc-outlet", "boise-willcall"]));
const SALES_NUMBER = zod_1.z
    .string()
    .min(3)
    .max(5)
    .regex(/^\d+$/, "Salesperson number must be digits only");
function normalizeSalespersonNumber(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits ? digits : null;
}
/**
 * GET /api/staff/users
 */
exports.staffUsersRouter.get("/", async (_req, res) => {
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
    const normalized = users.map((user) => ({
        ...user,
        locationAccess: (0, locationIds_1.normalizeLocationIds)(user.locationAccess ?? []),
    }));
    return res.json({ users: normalized });
});
/**
 * POST /api/staff/users
 * Creates staff user with generated temp password + mustChangePassword=true
 * Returns tempPassword so admin can email it.
 */
exports.staffUsersRouter.post("/", async (req, res) => {
    const body = zod_1.z.object({
        email: zod_1.z.string().email(),
        name: zod_1.z.string().min(1),
        role: zod_1.z.enum(["ADMIN", "STAFF", "VIEWER", "SALESPERSON"]).default("STAFF"),
        salespersonNumber: SALES_NUMBER.optional(),
        salespersonName: zod_1.z.string().min(1).optional(),
        salespersonPhone: zod_1.z.string().optional(),
        salespersonEmail: zod_1.z.string().email().optional(),
        locationAccess: LOCS.default(["slc-hq"])
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    console.log("[staff-users] create request", {
        email: body.data.email,
        role: body.data.role,
        locationAccess: body.data.locationAccess,
    });
    const email = body.data.email.toLowerCase();
    if (!email.endsWith("@mld.com"))
        return res.status(400).json({ message: "Email must end with @mld.com" });
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
    const tempPassword = (0, passwords_1.generateTempPassword)();
    const passwordHash = await (0, passwords_1.hashPassword)(tempPassword);
    const created = await prisma.staffUser.create({
        data: {
            email,
            name: body.data.name,
            role: body.data.role === "ADMIN"
                ? client_1.StaffRole.ADMIN
                : body.data.role === "VIEWER"
                    ? client_1.StaffRole.VIEWER
                    : body.data.role === "SALESPERSON"
                        ? client_1.StaffRole.SALESPERSON
                        : client_1.StaffRole.STAFF,
            locationAccess: body.data.role === "ADMIN"
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
    const message = (0, buildStaffOnboardingEmail_1.buildStaffOnboardingEmail)(created.name, loginUrl, tempPassword);
    try {
        await (0, sendEmail_1.sendEmail)(created.email, message.subject, message.body, {
            allowTestOverride: false,
            allowNonProdSend: true,
        });
    }
    catch (err) {
        console.error("[staff-users] onboarding email failed", err);
        return res.status(200).json({
            user: {
                ...created,
                locationAccess: (0, locationIds_1.normalizeLocationIds)(created.locationAccess ?? []),
            },
            emailSent: false,
            message: "User created but onboarding email failed to send.",
        });
    }
    return res.status(201).json({
        user: {
            ...created,
            locationAccess: (0, locationIds_1.normalizeLocationIds)(created.locationAccess ?? []),
        },
        emailSent: true,
    });
});
/**
 * GET /api/staff/users/:id
 */
exports.staffUsersRouter.get("/:id", async (req, res) => {
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
    if (!user)
        return res.status(404).json({ message: "Not found" });
    return res.json({
        user: {
            ...user,
            locationAccess: (0, locationIds_1.normalizeLocationIds)(user.locationAccess ?? []),
        },
    });
});
/**
 * PATCH /api/staff/users/:id
 * Edit user and/or disable. Admin role always gets all locations.
 */
exports.staffUsersRouter.patch("/:id", async (req, res) => {
    const body = zod_1.z.object({
        email: zod_1.z.string().email().optional(),
        name: zod_1.z.string().min(1).optional(),
        role: zod_1.z.enum(["ADMIN", "STAFF", "VIEWER", "SALESPERSON"]).optional(),
        locationAccess: LOCS.optional(),
        isActive: zod_1.z.boolean().optional(),
        mustChangePassword: zod_1.z.boolean().optional(),
        salespersonNumber: SALES_NUMBER.optional(),
        salespersonName: zod_1.z.string().min(1).optional(),
        salespersonPhone: zod_1.z.string().optional(),
        salespersonEmail: zod_1.z.string().email().optional(),
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    console.log("[staff-users] update request", {
        id: req.params.id,
        role: body.data.role,
        locationAccess: body.data.locationAccess,
        isActive: body.data.isActive,
    });
    const existing = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
    const nextRole = body.data.role ?? existing.role;
    const nextSalespersonNumber = body.data.salespersonNumber != null
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
            role: nextRole === "ADMIN"
                ? client_1.StaffRole.ADMIN
                : nextRole === "VIEWER"
                    ? client_1.StaffRole.VIEWER
                    : nextRole === "SALESPERSON"
                        ? client_1.StaffRole.SALESPERSON
                        : client_1.StaffRole.STAFF,
            locationAccess: nextRole === "ADMIN"
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
            locationAccess: (0, locationIds_1.normalizeLocationIds)(updated.locationAccess ?? []),
        },
    });
});
/**
 * DELETE /api/staff/users/:id
 */
exports.staffUsersRouter.delete("/:id", async (req, res) => {
    const existing = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
    await prisma.staffUser.delete({ where: { id: req.params.id } });
    return res.json({ ok: true });
});
