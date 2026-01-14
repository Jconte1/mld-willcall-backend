"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickupsRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const prisma = new client_1.PrismaClient();
exports.pickupsRouter = (0, express_1.Router)();
exports.pickupsRouter.use(auth_1.requireAuth);
exports.pickupsRouter.use(auth_1.blockIfMustChangePassword);
const STATUS = zod_1.z.enum(["Scheduled", "InProgress", "Ready", "Completed", "Cancelled"]);
function canAccessLocation(req, locationId) {
    if (req.auth.role === "ADMIN")
        return true;
    return (req.auth.locationAccess ?? []).includes(locationId);
}
/**
 * GET /api/staff/pickups
 * Optional query: locationId, status
 */
exports.pickupsRouter.get("/", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    const auth = req.auth;
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (locationId && !canAccessLocation(req, locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const where = {};
    if (locationId)
        where.locationId = locationId;
    if (status) {
        const parsed = STATUS.safeParse(status);
        if (!parsed.success)
            return res.status(400).json({ message: "Invalid status" });
        where.status = parsed.data;
    }
    // Staff scope by their locations (if no locationId explicitly provided)
    if (auth.role !== "ADMIN" && !locationId) {
        where.locationId = { in: auth.locationAccess ?? [] };
    }
    const pickups = await prisma.pickup.findMany({
        where,
        orderBy: { startAt: "asc" }
    });
    return res.json({ pickups });
});
/**
 * GET /api/staff/pickups/:id
 */
exports.pickupsRouter.get("/:id", async (req, res) => {
    const pickup = await prisma.pickup.findUnique({ where: { id: req.params.id } });
    if (!pickup)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, pickup.locationId))
        return res.status(403).json({ message: "Forbidden" });
    return res.json({ pickup });
});
/**
 * PATCH /api/staff/pickups/:id
 * Body: { status?, startAt?, endAt? }
 */
exports.pickupsRouter.patch("/:id", async (req, res) => {
    const body = zod_1.z.object({
        status: STATUS.optional(),
        startAt: zod_1.z.string().datetime().optional(),
        endAt: zod_1.z.string().datetime().optional()
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const existing = await prisma.pickup.findUnique({ where: { id: req.params.id } });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, existing.locationId))
        return res.status(403).json({ message: "Forbidden" });
    const updated = await prisma.pickup.update({
        where: { id: req.params.id },
        data: {
            status: body.data.status ? body.data.status : undefined,
            startAt: body.data.startAt ? new Date(body.data.startAt) : undefined,
            endAt: body.data.endAt ? new Date(body.data.endAt) : undefined
        }
    });
    return res.json({ pickup: updated });
});
