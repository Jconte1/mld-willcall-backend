"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickupsRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const locationIds_1 = require("../lib/locationIds");
const notifications_1 = require("../notifications");
const prisma = new client_1.PrismaClient();
exports.pickupsRouter = (0, express_1.Router)();
const LOCATION_IDS = ["slc-hq", "slc-outlet", "boise-willcall"];
exports.pickupsRouter.use(auth_1.requireAuth);
exports.pickupsRouter.use(auth_1.blockIfMustChangePassword);
const STATUS = zod_1.z.enum([
    "Scheduled",
    "Confirmed",
    "InProgress",
    "Ready",
    "Completed",
    "Cancelled",
    "NoShow",
]);
function canAccessLocation(req, locationId) {
    if (req.auth.role === "ADMIN")
        return true;
    return (0, locationIds_1.expandLocationIds)(req.auth.locationAccess ?? []).includes(locationId);
}
function canWritePickups(req) {
    return req.auth?.role !== "VIEWER";
}
/**
 * GET /api/staff/pickups
 * Optional query: locationId, status, from, to
 */
exports.pickupsRouter.get("/", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    const auth = req.auth;
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if (locationId && !canAccessLocation(req, locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const where = {};
    if (locationId) {
        const expanded = (0, locationIds_1.expandLocationIds)([locationId]);
        where.locationId = { in: expanded };
    }
    if (status) {
        const parsed = STATUS.safeParse(status);
        if (!parsed.success)
            return res.status(400).json({ message: "Invalid status" });
        where.status = parsed.data;
    }
    if (from) {
        const fromDate = new Date(from);
        if (Number.isNaN(fromDate.getTime())) {
            return res.status(400).json({ message: "Invalid from date" });
        }
        // Treat YYYY-MM-DD as a full-day lower bound in UTC.
        fromDate.setUTCHours(0, 0, 0, 0);
        where.startAt = { ...(where.startAt ?? {}), gte: fromDate };
    }
    if (to) {
        const toDate = new Date(to);
        if (Number.isNaN(toDate.getTime())) {
            return res.status(400).json({ message: "Invalid to date" });
        }
        // Treat YYYY-MM-DD as a full-day upper bound in UTC.
        toDate.setUTCHours(23, 59, 59, 999);
        where.startAt = { ...(where.startAt ?? {}), lte: toDate };
    }
    // Staff scope by their locations (if no locationId explicitly provided)
    if (auth.role !== "ADMIN" && !locationId) {
        where.locationId = { in: (0, locationIds_1.expandLocationIds)(auth.locationAccess ?? []) };
    }
    const pickups = await prisma.pickupAppointment.findMany({
        where,
        orderBy: { startAt: "asc" },
        include: { orders: true },
    });
    const normalized = pickups.map((pickup) => ({
        ...pickup,
        locationId: (0, locationIds_1.normalizeLocationId)(pickup.locationId) ?? pickup.locationId,
    }));
    return res.json({ pickups: normalized });
});
/**
 * POST /api/staff/pickups
 * Body: { locationId, customerEmail, customerFirstName, customerLastName?, customerPhone?, startAt, endAt, status?, orderNbrs? }
 */
exports.pickupsRouter.post("/", async (req, res) => {
    if (!canWritePickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z.object({
        locationId: zod_1.z.enum(LOCATION_IDS),
        customerEmail: zod_1.z.string().email(),
        customerFirstName: zod_1.z.string().min(1),
        customerLastName: zod_1.z.string().optional(),
        customerPhone: zod_1.z.string().optional(),
        vehicleInfo: zod_1.z.string().optional(),
        customerNotes: zod_1.z.string().optional(),
        startAt: zod_1.z.string().datetime(),
        endAt: zod_1.z.string().datetime(),
        status: STATUS.optional(),
        orderNbrs: zod_1.z.array(zod_1.z.string()).optional(),
        notifyCustomer: zod_1.z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    if (!canAccessLocation(req, body.data.locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const customerEmail = body.data.customerEmail.toLowerCase();
    const user = await prisma.users.findUnique({ where: { email: customerEmail } });
    if (!user) {
        return res.status(404).json({ message: "Customer not found" });
    }
    const created = await prisma.$transaction(async (tx) => {
        const appointment = await tx.pickupAppointment.create({
            data: {
                userId: user.id,
                email: customerEmail,
                pickupReference: body.data.orderNbrs?.join(", ") ?? "",
                locationId: body.data.locationId,
                startAt: new Date(body.data.startAt),
                endAt: new Date(body.data.endAt),
                status: body.data.status ? body.data.status : undefined,
                customerFirstName: body.data.customerFirstName,
                customerLastName: body.data.customerLastName ?? null,
                customerEmail: customerEmail,
                customerPhone: body.data.customerPhone ?? null,
                vehicleInfo: body.data.vehicleInfo ?? null,
                customerNotes: body.data.customerNotes ?? null,
            },
        });
        if (body.data.orderNbrs?.length) {
            await tx.pickupAppointmentOrder.createMany({
                data: body.data.orderNbrs.map((orderNbr) => ({
                    appointmentId: appointment.id,
                    orderNbr,
                })),
                skipDuplicates: true,
            });
        }
        return appointment;
    });
    if (body.data.notifyCustomer) {
        try {
            await (0, notifications_1.notifyStaffScheduled)(prisma, created, body.data.orderNbrs ?? []);
        }
        catch (err) {
            console.error("[notifications] staff schedule failed", err);
        }
    }
    return res.status(201).json({ pickup: created });
});
/**
 * GET /api/staff/pickups/:id
 */
exports.pickupsRouter.get("/:id", async (req, res) => {
    const pickup = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true },
    });
    if (!pickup)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, pickup.locationId))
        return res.status(403).json({ message: "Forbidden" });
    return res.json({
        pickup: {
            ...pickup,
            locationId: (0, locationIds_1.normalizeLocationId)(pickup.locationId) ?? pickup.locationId,
        },
    });
});
/**
 * PATCH /api/staff/pickups/:id
 * Body: { status?, startAt?, endAt?, locationId?, customer fields?, orderNbrs? }
 */
exports.pickupsRouter.patch("/:id", async (req, res) => {
    if (!canWritePickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z.object({
        status: STATUS.optional(),
        startAt: zod_1.z.string().datetime().optional(),
        endAt: zod_1.z.string().datetime().optional(),
        locationId: zod_1.z.string().optional(),
        customerFirstName: zod_1.z.string().optional(),
        customerLastName: zod_1.z.string().nullable().optional(),
        customerEmail: zod_1.z.string().email().optional(),
        customerPhone: zod_1.z.string().nullable().optional(),
        vehicleInfo: zod_1.z.string().nullable().optional(),
        customerNotes: zod_1.z.string().nullable().optional(),
        orderNbrs: zod_1.z.array(zod_1.z.string()).optional(),
        notifyCustomer: zod_1.z.boolean().optional(),
        cancelReason: zod_1.z.string().optional(),
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const nextCustomerEmail = body.data.customerEmail?.toLowerCase();
    const existing = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true },
    });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, existing.locationId))
        return res.status(403).json({ message: "Forbidden" });
    const nextLocationId = body.data.locationId ? (0, locationIds_1.normalizeLocationId)(body.data.locationId) : undefined;
    if (nextLocationId && !canAccessLocation(req, nextLocationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const updated = await prisma.$transaction(async (tx) => {
        if (body.data.orderNbrs) {
            await tx.pickupAppointmentOrder.deleteMany({ where: { appointmentId: existing.id } });
            const orderRows = body.data.orderNbrs.map((orderNbr) => ({
                appointmentId: existing.id,
                orderNbr,
            }));
            if (orderRows.length) {
                await tx.pickupAppointmentOrder.createMany({ data: orderRows, skipDuplicates: true });
            }
        }
        return tx.pickupAppointment.update({
            where: { id: req.params.id },
            data: {
                status: body.data.status ? body.data.status : undefined,
                startAt: body.data.startAt ? new Date(body.data.startAt) : undefined,
                endAt: body.data.endAt ? new Date(body.data.endAt) : undefined,
                locationId: nextLocationId ?? undefined,
                customerFirstName: body.data.customerFirstName,
                customerLastName: body.data.customerLastName ?? undefined,
                customerEmail: nextCustomerEmail ?? undefined,
                email: nextCustomerEmail ?? undefined,
                customerPhone: body.data.customerPhone ?? undefined,
                vehicleInfo: body.data.vehicleInfo ?? undefined,
                customerNotes: body.data.customerNotes ?? undefined,
            },
            include: { orders: true },
        });
    });
    const notifyCustomer = body.data.notifyCustomer ?? false;
    const cancelReason = body.data.cancelReason ?? null;
    const nextOrderNbrs = body.data.orderNbrs ?? existing.orders.map((o) => o.orderNbr);
    const timeChanged = (body.data.startAt && new Date(body.data.startAt).getTime() !== existing.startAt.getTime()) ||
        (body.data.endAt && new Date(body.data.endAt).getTime() !== existing.endAt.getTime());
    const locationChanged = body.data.locationId &&
        ((0, locationIds_1.normalizeLocationId)(body.data.locationId) ?? body.data.locationId) !== existing.locationId;
    const statusChanged = body.data.status && body.data.status !== existing.status;
    const terminalStatusChange = statusChanged &&
        (body.data.status === "Cancelled" ||
            body.data.status === "Completed" ||
            body.data.status === "NoShow");
    const orderListChanged = Array.isArray(body.data.orderNbrs) &&
        (body.data.orderNbrs.length !== existing.orders.length ||
            body.data.orderNbrs.some((orderNbr) => !existing.orders.some((o) => o.orderNbr === orderNbr)));
    try {
        if (!terminalStatusChange && (timeChanged || locationChanged)) {
            if (notifyCustomer) {
                await (0, notifications_1.notifyAppointmentRescheduled)(prisma, updated, nextOrderNbrs, existing.startAt, existing.endAt, notifyCustomer, true, true);
            }
            else {
                await (0, notifications_1.cancelAppointmentNotifications)(prisma, updated.id);
            }
        }
        if (statusChanged && body.data.status === "Completed") {
            await (0, notifications_1.notifyAppointmentCompleted)(prisma, updated, nextOrderNbrs, notifyCustomer, true, true);
        }
        if (statusChanged && body.data.status === "Cancelled") {
            await (0, notifications_1.notifyStaffCancelled)(prisma, updated, nextOrderNbrs, cancelReason, notifyCustomer);
        }
        if (statusChanged && body.data.status === "NoShow") {
            await (0, notifications_1.cancelAppointmentNotifications)(prisma, updated.id);
        }
        if (orderListChanged) {
            await (0, notifications_1.notifyOrderListChanged)(prisma, updated, nextOrderNbrs, notifyCustomer, true, true);
        }
    }
    catch (err) {
        console.error("[notifications] staff update failed", err);
    }
    return res.json({
        pickup: {
            ...updated,
            locationId: (0, locationIds_1.normalizeLocationId)(updated.locationId) ?? updated.locationId,
        },
    });
});
