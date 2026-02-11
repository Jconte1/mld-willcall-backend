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
exports.pickupsRouter.use(auth_1.blockIfMustCompleteProfile);
const STATUS = zod_1.z.enum([
    "Scheduled",
    "Confirmed",
    "InProgress",
    "Ready",
    "Completed",
    "Cancelled",
    "NoShow",
]);
const selectedItemSchema = zod_1.z.object({
    lineId: zod_1.z.string().optional(),
    inventoryId: zod_1.z.string().min(1),
    qty: zod_1.z.number().positive(),
    description: zod_1.z.string().optional().nullable(),
    warehouse: zod_1.z.string().optional().nullable(),
    maxQty: zod_1.z.number().optional(),
});
const selectedItemsSchema = zod_1.z.object({
    orderNbr: zod_1.z.string().min(1),
    items: zod_1.z.array(selectedItemSchema),
});
const SHIPMENT_FORMAT = /^SMT\d{7}$/;
const shipmentUpdateSchema = zod_1.z.object({
    orderNbr: zod_1.z.string().min(1),
    shipmentNbrs: zod_1.z.array(zod_1.z.string().min(1)).default([]),
});
function canAccessLocation(req, locationId) {
    if (req.auth.role === "ADMIN")
        return true;
    return (0, locationIds_1.expandLocationIds)(req.auth.locationAccess ?? []).includes(locationId);
}
function canWritePickups(req) {
    return req.auth?.role !== "VIEWER" && req.auth?.role !== "SALESPERSON";
}
function normalizeSelections(selectedItems, allowedOrders) {
    if (!selectedItems?.length)
        return [];
    const allowed = new Set(allowedOrders);
    return selectedItems
        .filter((selection) => allowed.has(selection.orderNbr))
        .map((selection) => ({
        orderNbr: selection.orderNbr,
        items: selection.items.filter((item) => item.inventoryId && item.qty > 0),
    }))
        .filter((selection) => selection.items.length > 0);
}
async function validateSelectedItemQty(selectedItems) {
    if (!selectedItems?.length)
        return null;
    const lineIds = Array.from(new Set(selectedItems.flatMap((selection) => selection.items.map((item) => item.lineId).filter(Boolean))));
    if (!lineIds.length)
        return null;
    const lines = await prisma.erpOrderLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, openQty: true, orderNbr: true },
    });
    const lineMap = new Map(lines.map((line) => [line.id, line]));
    for (const selection of selectedItems) {
        for (const item of selection.items) {
            if (!item.lineId)
                continue;
            const line = lineMap.get(item.lineId);
            if (!line)
                continue;
            const openQty = line.openQty == null ? null : Number(line.openQty);
            if (openQty != null && item.qty > openQty) {
                return {
                    orderNbr: selection.orderNbr,
                    lineId: item.lineId,
                    maxQty: openQty,
                };
            }
        }
    }
    return null;
}
function areSelectedItemsEqual(a, b) {
    const normalize = (items) => items
        .flatMap((selection) => selection.items.map((item) => ({
        orderNbr: selection.orderNbr,
        lineId: item.lineId ?? "",
        inventoryId: item.inventoryId,
        qty: Number(item.qty),
    })))
        .sort((x, y) => `${x.orderNbr}-${x.lineId}-${x.inventoryId}`.localeCompare(`${y.orderNbr}-${y.lineId}-${y.inventoryId}`));
    const left = normalize(a);
    const right = normalize(b);
    if (left.length !== right.length)
        return false;
    return left.every((item, idx) => item.orderNbr === right[idx].orderNbr &&
        item.lineId === right[idx].lineId &&
        item.inventoryId === right[idx].inventoryId &&
        item.qty === right[idx].qty);
}
function normalizeShipmentNbr(input) {
    return input.trim().toUpperCase();
}
function validateShipmentNbrs(input) {
    const normalized = input.map(normalizeShipmentNbr).filter(Boolean);
    const invalid = normalized.find((value) => !SHIPMENT_FORMAT.test(value));
    if (invalid) {
        return { ok: false, invalid };
    }
    return { ok: true, values: Array.from(new Set(normalized)) };
}
/**
 * GET /api/staff/pickups
 * Optional query: locationId, status, from, to
 */
exports.pickupsRouter.get("/", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    console.info("[staff-pickups] request", {
        id: req.auth.id,
        email: req.auth.email,
        role: req.auth.role,
        mustChangePassword: req.auth.mustChangePassword,
        mustCompleteProfile: req.auth.mustCompleteProfile,
        locationAccess: req.auth.locationAccess ?? [],
        query: req.query,
    });
    const auth = req.auth;
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if (locationId && !canAccessLocation(req, locationId)) {
        console.warn("[staff-pickups] forbidden location", {
            id: auth.id,
            role: auth.role,
            locationId,
            locationAccess: auth.locationAccess ?? [],
        });
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
        include: { orders: true, shipments: true },
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
        selectedItems: zod_1.z.array(selectedItemsSchema).optional(),
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
    const orderNbrs = body.data.orderNbrs ?? [];
    const normalizedSelections = normalizeSelections(body.data.selectedItems, orderNbrs);
    const invalidQty = await validateSelectedItemQty(normalizedSelections);
    if (invalidQty) {
        return res.status(400).json({
            message: "Selected quantity exceeds open quantity.",
            orderNbr: invalidQty.orderNbr,
            lineId: invalidQty.lineId,
            maxQty: invalidQty.maxQty,
        });
    }
    const created = await prisma.$transaction(async (tx) => {
        const appointment = await tx.pickupAppointment.create({
            data: {
                userId: user.id,
                email: customerEmail,
                pickupReference: orderNbrs.join(", "),
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
        if (orderNbrs.length) {
            await tx.pickupAppointmentOrder.createMany({
                data: orderNbrs.map((orderNbr) => ({
                    appointmentId: appointment.id,
                    orderNbr,
                })),
                skipDuplicates: true,
            });
        }
        const lineRows = normalizedSelections.flatMap((selection) => selection.items.map((item) => ({
            appointmentId: appointment.id,
            orderNbr: selection.orderNbr,
            lineId: item.lineId ?? null,
            inventoryId: item.inventoryId,
            qtySelected: item.qty,
            lineDescription: item.description ?? null,
        })));
        if (lineRows.length) {
            await tx.pickupAppointmentLine.createMany({ data: lineRows });
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
        include: { orders: true, shipments: true },
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
 * GET /api/staff/pickups/:id/items
 */
exports.pickupsRouter.get("/:id/items", async (req, res) => {
    const pickup = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, lines: true, shipments: true },
    });
    if (!pickup)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, pickup.locationId))
        return res.status(403).json({ message: "Forbidden" });
    const orderNbrs = pickup.orders.map((order) => order.orderNbr);
    const orderLines = await prisma.erpOrderLine.findMany({
        where: { orderNbr: { in: orderNbrs } },
        select: {
            id: true,
            orderNbr: true,
            inventoryId: true,
            lineDescription: true,
            openQty: true,
            orderQty: true,
            warehouse: true,
        },
        orderBy: [{ orderNbr: "asc" }],
    });
    return res.json({
        pickupId: pickup.id,
        orderNbrs,
        lines: pickup.lines,
        orderLines,
        shipments: pickup.shipments,
    });
});
/**
 * PATCH /api/staff/pickups/:id/shipments
 * Body: { shipments: [{ orderNbr, shipmentNbrs: string[] }] }
 */
exports.pickupsRouter.patch("/:id/shipments", async (req, res) => {
    if (!canWritePickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z
        .object({
        shipments: zod_1.z.array(shipmentUpdateSchema),
    })
        .safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const appointment = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, shipments: true },
    });
    if (!appointment)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, appointment.locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const allowedOrders = new Set(appointment.orders.map((order) => order.orderNbr));
    const incoming = body.data.shipments;
    for (const entry of incoming) {
        if (!allowedOrders.has(entry.orderNbr)) {
            return res.status(400).json({ message: "Invalid order for appointment." });
        }
        const validation = validateShipmentNbrs(entry.shipmentNbrs);
        if (!validation.ok) {
            return res.status(400).json({
                message: "Invalid shipment number format.",
                shipmentNbr: validation.invalid,
            });
        }
    }
    const shipmentRows = incoming.flatMap((entry) => {
        const validation = validateShipmentNbrs(entry.shipmentNbrs);
        if (!validation.ok)
            return [];
        return validation.values.map((shipmentNbr) => ({
            appointmentId: appointment.id,
            orderNbr: entry.orderNbr,
            shipmentNbr,
            createdByUserId: req.auth?.id ?? null,
        }));
    });
    await prisma.$transaction(async (tx) => {
        const orderNbrs = incoming.map((entry) => entry.orderNbr);
        if (orderNbrs.length) {
            await tx.pickupAppointmentShipment.deleteMany({
                where: { appointmentId: appointment.id, orderNbr: { in: orderNbrs } },
            });
        }
        if (shipmentRows.length) {
            await tx.pickupAppointmentShipment.createMany({ data: shipmentRows });
        }
        const shipmentsByOrder = incoming.reduce((map, entry) => {
            map.set(entry.orderNbr, entry.shipmentNbrs.filter(Boolean));
            return map;
        }, new Map());
        const allShipped = appointment.orders.every((order) => (shipmentsByOrder.get(order.orderNbr) ?? []).length > 0);
        if (appointment.status === "Ready" && !allShipped) {
            await tx.pickupAppointment.update({
                where: { id: appointment.id },
                data: { status: "Scheduled" },
            });
        }
    });
    const updated = await prisma.pickupAppointment.findUnique({
        where: { id: appointment.id },
        include: { orders: true, shipments: true },
    });
    return res.json({
        pickup: {
            ...updated,
            locationId: updated
                ? (0, locationIds_1.normalizeLocationId)(updated.locationId) ?? updated.locationId
                : appointment.locationId,
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
        selectedItems: zod_1.z.array(selectedItemsSchema).optional(),
        notifyCustomer: zod_1.z.boolean().optional(),
        cancelReason: zod_1.z.string().optional(),
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const nextCustomerEmail = body.data.customerEmail?.toLowerCase();
    const existing = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, lines: true },
    });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, existing.locationId))
        return res.status(403).json({ message: "Forbidden" });
    const nextLocationId = body.data.locationId ? (0, locationIds_1.normalizeLocationId)(body.data.locationId) : undefined;
    if (nextLocationId && !canAccessLocation(req, nextLocationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const nextOrderNbrs = body.data.orderNbrs ?? existing.orders.map((o) => o.orderNbr);
    const normalizedSelections = normalizeSelections(body.data.selectedItems, nextOrderNbrs);
    const invalidQty = await validateSelectedItemQty(normalizedSelections);
    if (invalidQty) {
        return res.status(400).json({
            message: "Selected quantity exceeds open quantity.",
            orderNbr: invalidQty.orderNbr,
            lineId: invalidQty.lineId,
            maxQty: invalidQty.maxQty,
        });
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
            await tx.pickupAppointmentLine.deleteMany({
                where: {
                    appointmentId: existing.id,
                    orderNbr: { notIn: body.data.orderNbrs },
                },
            });
        }
        if (body.data.selectedItems) {
            await tx.pickupAppointmentLine.deleteMany({ where: { appointmentId: existing.id } });
            const lineRows = normalizedSelections.flatMap((selection) => selection.items.map((item) => ({
                appointmentId: existing.id,
                orderNbr: selection.orderNbr,
                lineId: item.lineId ?? null,
                inventoryId: item.inventoryId,
                qtySelected: item.qty,
                lineDescription: item.description ?? null,
            })));
            if (lineRows.length) {
                await tx.pickupAppointmentLine.createMany({ data: lineRows });
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
    const effectiveOrderNbrs = nextOrderNbrs;
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
    const existingSelections = Array.from(existing.lines.reduce((map, line) => {
        const entry = map.get(line.orderNbr) ?? [];
        entry.push({
            lineId: line.lineId ?? undefined,
            inventoryId: line.inventoryId,
            qty: Number(line.qtySelected),
        });
        map.set(line.orderNbr, entry);
        return map;
    }, new Map())).map(([orderNbr, items]) => ({ orderNbr, items }));
    const itemsChanged = Array.isArray(body.data.selectedItems)
        ? !areSelectedItemsEqual(existingSelections, normalizedSelections)
        : false;
    try {
        if (!terminalStatusChange && (timeChanged || locationChanged)) {
            if (notifyCustomer) {
                await (0, notifications_1.notifyAppointmentRescheduled)(prisma, updated, effectiveOrderNbrs, existing.startAt, existing.endAt, notifyCustomer, true, true);
            }
            else {
                await (0, notifications_1.cancelAppointmentNotifications)(prisma, updated.id);
            }
            if (updated.status === "Ready") {
                await (0, notifications_1.notifyAppointmentReady)(prisma, updated, effectiveOrderNbrs, true, true, true);
            }
        }
        if (statusChanged && body.data.status === "Completed") {
            await (0, notifications_1.notifyAppointmentCompleted)(prisma, updated, effectiveOrderNbrs, notifyCustomer, true, true);
        }
        if (statusChanged && body.data.status === "Ready") {
            await (0, notifications_1.notifyAppointmentReady)(prisma, updated, effectiveOrderNbrs, notifyCustomer, true, true);
        }
        if (statusChanged && body.data.status === "Cancelled") {
            await (0, notifications_1.cancelAppointmentNotifications)(prisma, updated.id);
            await (0, notifications_1.notifyStaffCancelled)(prisma, updated, effectiveOrderNbrs, cancelReason, notifyCustomer);
        }
        if (statusChanged && body.data.status === "NoShow") {
            await (0, notifications_1.cancelAppointmentNotifications)(prisma, updated.id);
        }
        if (orderListChanged || itemsChanged) {
            await (0, notifications_1.notifyOrderListChanged)(prisma, updated, effectiveOrderNbrs, notifyCustomer, true, true);
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
