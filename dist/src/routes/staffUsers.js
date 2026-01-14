"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.staffUsersRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const passwords_1 = require("../lib/passwords");
const auth_1 = require("../middleware/auth");
const prisma = new client_1.PrismaClient();
exports.staffUsersRouter = (0, express_1.Router)();
exports.staffUsersRouter.use(auth_1.requireAuth);
exports.staffUsersRouter.use((0, auth_1.requireRole)("ADMIN"));
const LOCS = zod_1.z.array(zod_1.z.enum(["slc", "boise"]));
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
            createdAt: true,
            updatedAt: true
        }
    });
    return res.json({ users });
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
        role: zod_1.z.enum(["ADMIN", "STAFF"]).default("STAFF"),
        locationAccess: LOCS.default(["slc"])
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const email = body.data.email.toLowerCase();
    if (!email.endsWith("@mld.com"))
        return res.status(400).json({ message: "Email must end with @mld.com" });
    const tempPassword = (0, passwords_1.generateTempPassword)();
    const passwordHash = await (0, passwords_1.hashPassword)(tempPassword);
    const created = await prisma.staffUser.create({
        data: {
            email,
            name: body.data.name,
            role: body.data.role === "ADMIN" ? client_1.StaffRole.ADMIN : client_1.StaffRole.STAFF,
            locationAccess: body.data.role === "ADMIN" ? ["slc", "boise"] : body.data.locationAccess,
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
    return res.status(201).json({ user: created, tempPassword });
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
            createdAt: true,
            updatedAt: true
        }
    });
    if (!user)
        return res.status(404).json({ message: "Not found" });
    return res.json({ user });
});
/**
 * PATCH /api/staff/users/:id
 * Edit user and/or disable. Admin role always gets all locations.
 */
exports.staffUsersRouter.patch("/:id", async (req, res) => {
    const body = zod_1.z.object({
        email: zod_1.z.string().email().optional(),
        name: zod_1.z.string().min(1).optional(),
        role: zod_1.z.enum(["ADMIN", "STAFF"]).optional(),
        locationAccess: LOCS.optional(),
        isActive: zod_1.z.boolean().optional(),
        mustChangePassword: zod_1.z.boolean().optional()
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const existing = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
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
            role: nextRole === "ADMIN" ? client_1.StaffRole.ADMIN : client_1.StaffRole.STAFF,
            locationAccess: nextRole === "ADMIN"
                ? ["slc", "boise"]
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
    return res.json({ user: updated });
});
