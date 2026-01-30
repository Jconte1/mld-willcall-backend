"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicOrderReadyRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const orderHelpers_1 = require("../lib/orders/orderHelpers");
const ingestOrderReadyDetails_1 = require("../lib/acumatica/ingest/ingestOrderReadyDetails");
const fetchOrderReadyReport_1 = require("../lib/acumatica/fetch/fetchOrderReadyReport");
const buildLink_1 = require("../notifications/links/buildLink");
const tokens_1 = require("../notifications/links/tokens");
const sendEmail_1 = require("../notifications/providers/email/sendEmail");
const sendSms_1 = require("../notifications/providers/sms/sendSms");
const buildOrderReadyEmail_1 = require("../notifications/templates/email/buildOrderReadyEmail");
const prisma = new client_1.PrismaClient();
exports.publicOrderReadyRouter = (0, express_1.Router)();
const tokenSchema = zod_1.z.object({
    token: zod_1.z.string().min(1),
});
const resendSchema = zod_1.z
    .object({
    orderNbr: zod_1.z.string().min(1),
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().optional(),
})
    .superRefine((data, ctx) => {
    if (!data.email && !data.phone) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "email or phone is required",
        });
        return;
    }
    if (data.email && data.phone) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "provide only one of email or phone",
        });
    }
});
const SCHEDULED_STATUSES = [
    client_1.PickupAppointmentStatus.Scheduled,
    client_1.PickupAppointmentStatus.Confirmed,
    client_1.PickupAppointmentStatus.InProgress,
    client_1.PickupAppointmentStatus.Ready,
    client_1.PickupAppointmentStatus.Completed,
];
const STALE_MS = 60 * 60 * 1000;
const READY_LINES_STALE_MS = 60 * 60 * 1000;
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits || null;
}
function getClientIp(req) {
    const xf = req.headers["x-forwarded-for"] || "";
    if (xf)
        return xf.split(",")[0].trim();
    return req.ip || req.connection?.remoteAddress || "";
}
async function checkLockout(key) {
    const row = await prisma.inviteLockout.findUnique({ where: { key } });
    if (!row?.lockedUntil)
        return { locked: false };
    if (row.lockedUntil.getTime() <= Date.now())
        return { locked: false };
    return { locked: true, lockedUntil: row.lockedUntil };
}
async function recordAttempt(key, ok) {
    const now = new Date();
    const row = await prisma.inviteLockout.findUnique({ where: { key } });
    if (!row) {
        await prisma.inviteLockout.create({
            data: {
                key,
                attemptCount: ok ? 0 : 1,
                lastAttemptAt: now,
                lockedUntil: ok ? null : null,
            },
        });
        return;
    }
    if (ok) {
        await prisma.inviteLockout.update({
            where: { key },
            data: { attemptCount: 0, lastAttemptAt: now, lockedUntil: null },
        });
        return;
    }
    const withinWindow = row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < LOCKOUT_WINDOW_MS;
    const nextCount = withinWindow ? row.attemptCount + 1 : 1;
    const lockedUntil = nextCount >= LOCKOUT_MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_WINDOW_MS) : null;
    await prisma.inviteLockout.update({
        where: { key },
        data: { attemptCount: nextCount, lastAttemptAt: now, lockedUntil },
    });
}
function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
/**
 * GET /api/public/order-ready/:orderNbr?token=...
 */
exports.publicOrderReadyRouter.get("/:orderNbr", async (req, res) => {
    const parsed = tokenSchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid token" });
    }
    const orderNbr = req.params.orderNbr;
    const notice = await prisma.orderReadyNotice.findUnique({
        where: { orderNbr },
    });
    if (!notice)
        return res.status(404).json({ message: "Not found" });
    const token = await prisma.orderReadyAccessToken.findFirst({
        where: { orderReadyId: notice.id, token: parsed.data.token, revokedAt: null },
    });
    if (!token)
        return res.status(403).json({ message: "Invalid token" });
    let appointment = null;
    if (notice.scheduledAppointmentId) {
        appointment = await prisma.pickupAppointment.findUnique({
            where: { id: notice.scheduledAppointmentId },
            include: { orders: true },
        });
    }
    else {
        const appointmentOrder = await prisma.pickupAppointmentOrder.findFirst({
            where: {
                orderNbr,
                appointment: { status: { in: SCHEDULED_STATUSES } },
            },
            include: { appointment: { include: { orders: true } } },
            orderBy: { appointment: { startAt: "desc" } },
        });
        appointment = appointmentOrder?.appointment ?? null;
        if (appointment?.id) {
            await prisma.orderReadyNotice.update({
                where: { id: notice.id },
                data: { scheduledAppointmentId: appointment.id },
            });
        }
    }
    if (notice.baid) {
        const summary = await prisma.erpOrderSummary.findUnique({
            where: { baid_orderNbr: { baid: notice.baid, orderNbr } },
            select: { updatedAt: true },
        });
        const updatedAt = summary?.updatedAt ? new Date(summary.updatedAt).getTime() : 0;
        const isStale = !updatedAt || Date.now() - updatedAt > STALE_MS;
        if (isStale) {
            try {
                await (0, ingestOrderReadyDetails_1.refreshOrderReadyDetails)({
                    baid: notice.baid,
                    orderNbr,
                    status: notice.status,
                    locationId: notice.locationId,
                    shipVia: notice.shipVia,
                });
            }
            catch (err) {
                console.error("[order-ready] refresh failed", err);
            }
        }
    }
    const readyLinesStale = !notice.lastReadyAt || Date.now() - new Date(notice.lastReadyAt).getTime() > READY_LINES_STALE_MS;
    if (readyLinesStale) {
        await refreshReadyLines(notice.id, notice.orderNbr);
    }
    const readyLineRows = await prisma.orderReadyLine.findMany({
        where: { orderReadyId: notice.id },
        select: { inventoryId: true },
    });
    const readyInventoryIds = new Set(readyLineRows.map((row) => String(row.inventoryId || "").trim()).filter(Boolean));
    const lines = await prisma.erpOrderLine.findMany({
        where: {
            orderNbr,
            ...(readyInventoryIds.size ? { inventoryId: { in: Array.from(readyInventoryIds) } } : {}),
        },
        select: {
            id: true,
            inventoryId: true,
            lineDescription: true,
            warehouse: true,
            openQty: true,
            orderQty: true,
            allocatedQty: true,
            isAllocated: true,
            amount: true,
            taxRate: true,
        },
        orderBy: { inventoryId: "asc" },
    });
    const orderLines = lines.map((line) => ({
        id: line.id,
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        warehouse: line.warehouse,
        openQty: (0, orderHelpers_1.toNumber)(line.openQty),
        orderQty: (0, orderHelpers_1.toNumber)(line.orderQty),
        allocatedQty: (0, orderHelpers_1.toNumber)(line.allocatedQty),
        isAllocated: line.isAllocated,
        amount: (0, orderHelpers_1.toNumber)(line.amount),
        taxRate: (0, orderHelpers_1.toNumber)(line.taxRate),
    }));
    const payment = await prisma.erpOrderPayment.findFirst({
        where: {
            orderNbr,
            ...(notice.baid ? { baid: notice.baid } : {}),
        },
        select: {
            orderTotal: true,
            unpaidBalance: true,
            terms: true,
            status: true,
        },
    });
    return res.json({
        orderReady: {
            orderNbr: notice.orderNbr,
            status: notice.status,
            orderType: notice.orderType,
            shipVia: notice.shipVia,
            qtyUnallocated: (0, orderHelpers_1.toNumber)(notice.qtyUnallocated),
            qtyAllocated: (0, orderHelpers_1.toNumber)(notice.qtyAllocated),
            customerId: notice.customerId,
            customerLocationId: notice.customerLocationId,
            contactName: notice.contactName,
            contactPhone: notice.contactPhone,
            contactEmail: notice.contactEmail,
            locationId: notice.locationId,
            smsOptIn: notice.smsOptIn,
        },
        appointment,
        payment: payment
            ? {
                orderTotal: (0, orderHelpers_1.toNumber)(payment.orderTotal),
                unpaidBalance: (0, orderHelpers_1.toNumber)(payment.unpaidBalance),
                terms: payment.terms,
                status: payment.status,
            }
            : null,
        orderLines,
    });
});
async function refreshReadyLines(orderReadyId, orderNbr) {
    const rows = await (0, fetchOrderReadyReport_1.fetchOrderReadyReport)();
    const inventoryIds = new Set();
    for (const row of rows) {
        const rowOrderNbr = String(row.orderNbr || "").trim();
        if (!rowOrderNbr || rowOrderNbr !== orderNbr)
            continue;
        const inv = row.inventoryId ? String(row.inventoryId).trim() : "";
        if (inv)
            inventoryIds.add(inv);
    }
    await prisma.orderReadyLine.deleteMany({ where: { orderReadyId } });
    if (inventoryIds.size) {
        await prisma.orderReadyLine.createMany({
            data: Array.from(inventoryIds).map((inventoryId) => ({
                orderReadyId,
                orderNbr,
                inventoryId,
            })),
            skipDuplicates: true,
        });
    }
    await prisma.orderReadyNotice.update({
        where: { id: orderReadyId },
        data: { lastReadyAt: new Date() },
    });
}
/**
 * POST /api/public/order-ready/resend
 * Body: { orderNbr, email? } OR { orderNbr, phone? }
 */
exports.publicOrderReadyRouter.post("/resend", async (req, res) => {
    const parsed = resendSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.json({
            ok: true,
            message: "If your information matches, you will receive a link shortly.",
        });
    }
    const orderNbr = parsed.data.orderNbr.trim();
    const email = parsed.data.email?.toLowerCase().trim() ?? null;
    const phone = normalizePhone(parsed.data.phone);
    const ip = getClientIp(req);
    const orderKey = `order-ready:${orderNbr}`;
    const ipKey = ip ? `order-ready-ip:${ip}` : "";
    const [orderLock, ipLock] = await Promise.all([
        checkLockout(orderKey),
        ipKey ? checkLockout(ipKey) : Promise.resolve({ locked: false }),
    ]);
    if (orderLock.locked || ipLock.locked) {
        return res.json({
            ok: true,
            message: "If your information matches, you will receive a link shortly.",
        });
    }
    const notice = await prisma.orderReadyNotice.findUnique({
        where: { orderNbr },
    });
    const contactEmail = (notice?.contactEmail || "").toLowerCase().trim() || null;
    const contactPhone = normalizePhone(notice?.contactPhone);
    const match = (email && contactEmail && email === contactEmail) ||
        (phone && contactPhone && phone === contactPhone);
    const matched = Boolean(match);
    await recordAttempt(orderKey, matched);
    if (ipKey)
        await recordAttempt(ipKey, matched);
    if (match && notice) {
        const tokenRow = await (0, tokens_1.rotateOrderReadyToken)(prisma, notice.id);
        const link = (0, buildLink_1.buildOrderReadyLink)(orderNbr, tokenRow.token);
        if (email) {
            const message = (0, buildOrderReadyEmail_1.buildOrderReadyEmail)(orderNbr, link);
            await (0, sendEmail_1.sendEmail)(email, message.subject, message.body);
        }
        else if (phone) {
            const smsBody = `Order ${orderNbr} is ready for pickup. Schedule here: ${link}`;
            await (0, sendSms_1.sendSms)(phone, smsBody);
        }
        await prisma.orderReadyNotice.update({
            where: { id: notice.id },
            data: {
                lastNotifiedAt: new Date(),
                nextEligibleNotifyAt: addDays(new Date(), 5),
            },
        });
    }
    return res.json({
        ok: true,
        message: "If your information matches, you will receive a link shortly.",
    });
});
