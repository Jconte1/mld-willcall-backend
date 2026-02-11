"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicAppointmentsRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const notifications_1 = require("../notifications");
const buildLink_1 = require("../notifications/links/buildLink");
const tokens_1 = require("../notifications/links/tokens");
const orderHelpers_1 = require("../lib/orders/orderHelpers");
const prisma = new client_1.PrismaClient();
exports.publicAppointmentsRouter = (0, express_1.Router)();
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_MINUTES = 15;
const OPEN_HOUR = 7;
const CLOSE_HOUR = 17;
const MIN_ADVANCE_MINUTES = 4 * 60;
const NEXT_DAY_EARLIEST_MINUTES = 10 * 60;
const tokenSchema = zod_1.z.object({
    token: zod_1.z.string().min(1),
});
const slotSchema = zod_1.z.object({
    startTime: zod_1.z.string().regex(TIME_RE),
    endTime: zod_1.z.string().regex(TIME_RE),
});
const rescheduleSchema = zod_1.z.object({
    action: zod_1.z.literal("reschedule"),
    selectedDate: zod_1.z.string().regex(DATE_RE),
    selectedSlots: zod_1.z.array(slotSchema).min(1).max(2),
});
const cancelSchema = zod_1.z.object({
    action: zod_1.z.literal("cancel"),
});
function timeToMinutes(time) {
    const [hh, mm] = time.split(":").map((part) => Number(part));
    return hh * 60 + mm;
}
function isWeekend(dateStr) {
    const date = parseDateOnly(dateStr);
    const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        weekday: "short",
    }).format(date);
    return weekday === "Sat" || weekday === "Sun";
}
function formatDateInDenver(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value ?? "0000";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const d = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${d}`;
}
function getDenverParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
    const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
    return {
        dateStr,
        hour: Number(get("hour")),
        minute: Number(get("minute")),
    };
}
function parseDateOnly(dateStr) {
    // Anchor in Denver midday to avoid UTC date shifts.
    return new Date(`${dateStr}T12:00:00-07:00`);
}
function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}
function nextBusinessDateStr(dateStr) {
    let cursor = parseDateOnly(dateStr);
    while (true) {
        cursor = addMinutes(cursor, 24 * 60);
        const next = formatDateInDenver(cursor);
        if (!isWeekend(next))
            return next;
    }
}
function ceilToSlot(minutes) {
    return Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}
function ensureWithinBusinessHours(dateStr, slots) {
    if (isWeekend(dateStr))
        return false;
    const startMinutes = OPEN_HOUR * 60;
    const lastStartMinutes = (CLOSE_HOUR * 60) - SLOT_MINUTES;
    return slots.every((slot) => {
        const minutes = timeToMinutes(slot.startTime);
        return minutes >= startMinutes && minutes <= lastStartMinutes;
    });
}
function areSlotsContiguous(slots) {
    if (slots.length <= 1)
        return true;
    const ordered = [...slots].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    return timeToMinutes(ordered[1].startTime) - timeToMinutes(ordered[0].startTime) === SLOT_MINUTES;
}
function makeDateTime(dateStr, time) {
    return new Date(`${dateStr}T${time}:00-07:00`);
}
function getMinAllowedSlot(now) {
    const timeStr = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(now);
    const [hour, minute] = timeStr.split(":").map((part) => Number(part));
    const todayStr = formatDateInDenver(now);
    const closeMinutes = CLOSE_HOUR * 60;
    const lastStartMinutes = closeMinutes - SLOT_MINUTES;
    if (isWeekend(todayStr)) {
        return { dateStr: nextBusinessDateStr(todayStr), minutes: OPEN_HOUR * 60 + MIN_ADVANCE_MINUTES };
    }
    const nowMinutes = hour * 60 + minute;
    let minMinutes = nowMinutes + MIN_ADVANCE_MINUTES;
    let minDateStr = todayStr;
    if (minMinutes > closeMinutes) {
        const remaining = minMinutes - closeMinutes;
        minDateStr = nextBusinessDateStr(todayStr);
        minMinutes = OPEN_HOUR * 60 + remaining;
    }
    if (minMinutes < OPEN_HOUR * 60)
        minMinutes = OPEN_HOUR * 60;
    if (minMinutes > lastStartMinutes) {
        minDateStr = nextBusinessDateStr(minDateStr);
        minMinutes = OPEN_HOUR * 60 + MIN_ADVANCE_MINUTES;
    }
    minMinutes = ceilToSlot(minMinutes);
    return { dateStr: minDateStr, minutes: minMinutes };
}
async function validateToken(appointmentId, token) {
    return prisma.appointmentAccessToken.findFirst({
        where: {
            appointmentId,
            token,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
    });
}
async function getLatestLink(appointmentId) {
    const token = await (0, tokens_1.getActiveToken)(prisma, appointmentId);
    if (!token)
        return null;
    return (0, buildLink_1.buildAppointmentLink)(appointmentId, token.token);
}
/**
 * GET /api/public/appointments/short/:token
 */
exports.publicAppointmentsRouter.get("/short/:token", async (req, res) => {
    const tokenValue = req.params.token;
    const frontend = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/+$/, "");
    const token = await prisma.appointmentAccessToken.findFirst({
        where: {
            token: tokenValue,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
    });
    if (!token) {
        return res.redirect(`${frontend}/appointments/invalid`);
    }
    const longLink = (0, buildLink_1.buildAppointmentLink)(token.appointmentId, tokenValue);
    return res.redirect(longLink);
});
/**
 * GET /api/public/appointments/:id?token=...
 */
exports.publicAppointmentsRouter.get("/:id", async (req, res) => {
    const parsed = tokenSchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid token" });
    }
    const token = await validateToken(req.params.id, parsed.data.token);
    if (!token)
        return res.status(403).json({ message: "Invalid or expired token" });
    const appointment = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true },
    });
    if (!appointment)
        return res.status(404).json({ message: "Not found" });
    const orderNbrs = appointment.orders.map((order) => order.orderNbr);
    const selectedLines = await prisma.pickupAppointmentLine.findMany({
        where: { appointmentId: appointment.id },
        select: {
            orderNbr: true,
            inventoryId: true,
            lineDescription: true,
            qtySelected: true,
        },
        orderBy: [{ orderNbr: "asc" }, { inventoryId: "asc" }],
    });
    const orderLines = orderNbrs.map((orderNbr) => ({
        orderNbr,
        items: selectedLines
            .filter((line) => line.orderNbr === orderNbr)
            .map((line) => ({
            inventoryId: line.inventoryId,
            lineDescription: line.lineDescription,
            qty: (0, orderHelpers_1.toNumber)(line.qtySelected),
        })),
    }));
    return res.json({ appointment, orderLines });
});
/**
 * GET /api/public/appointments/:id/unsubscribe?token=...
 */
exports.publicAppointmentsRouter.get("/:id/unsubscribe", async (req, res) => {
    const parsed = tokenSchema.safeParse(req.query);
    const frontend = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/+$/, "");
    if (!parsed.success) {
        return res.redirect(`${frontend}/unsubscribe?status=invalid`);
    }
    const token = await prisma.appointmentAccessToken.findFirst({
        where: {
            appointmentId: req.params.id,
            token: parsed.data.token,
        },
    });
    if (!token) {
        return res.redirect(`${frontend}/unsubscribe?status=invalid`);
    }
    await prisma.pickupAppointment.update({
        where: { id: req.params.id },
        data: {
            emailOptIn: false,
            emailOptInAt: null,
            emailOptInSource: "unsubscribe",
        },
    });
    return res.redirect(`${frontend}/unsubscribe?status=success`);
});
/**
 * PATCH /api/public/appointments/:id?token=...
 * Body: { action: "cancel" } or { action: "reschedule", selectedDate, selectedSlots }
 */
exports.publicAppointmentsRouter.patch("/:id", async (req, res) => {
    const parsedToken = tokenSchema.safeParse(req.query);
    if (!parsedToken.success) {
        return res.status(400).json({ message: "Invalid token" });
    }
    const token = await validateToken(req.params.id, parsedToken.data.token);
    if (!token)
        return res.status(403).json({ message: "Invalid or expired token" });
    const action = req.body?.action;
    const appointment = await prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true },
    });
    if (!appointment)
        return res.status(404).json({ message: "Not found" });
    if (action === "cancel") {
        if (appointment.status === client_1.PickupAppointmentStatus.Cancelled) {
            return res.json({ appointment });
        }
        const parsed = cancelSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ message: "Invalid request body" });
        const updated = await prisma.pickupAppointment.update({
            where: { id: appointment.id },
            data: { status: client_1.PickupAppointmentStatus.Cancelled },
        });
        await (0, notifications_1.cancelAppointmentNotifications)(prisma, updated.id);
        await (0, notifications_1.notifyCustomerCancelled)(prisma, updated, appointment.orders.map((o) => o.orderNbr));
        const nextLink = await getLatestLink(updated.id);
        return res.json({ appointment: updated, nextLink });
    }
    const parsed = rescheduleSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request body" });
    }
    const disallowedStatuses = [
        client_1.PickupAppointmentStatus.Completed,
        client_1.PickupAppointmentStatus.NoShow,
    ];
    if (disallowedStatuses.includes(appointment.status)) {
        return res.status(409).json({ message: "Appointment cannot be rescheduled." });
    }
    const requiredSlots = appointment.orders.length > 6 ? 2 : 1;
    if (parsed.data.selectedSlots.length !== requiredSlots) {
        return res.status(400).json({ message: "Selected slots do not match appointment size." });
    }
    if (!ensureWithinBusinessHours(parsed.data.selectedDate, parsed.data.selectedSlots)) {
        return res.status(400).json({ message: "Selected time is outside business hours." });
    }
    const minAllowed = getMinAllowedSlot(new Date());
    const now = new Date();
    console.log("[public-appointments][min-advance]", {
        now: now.toISOString(),
        denverDate: formatDateInDenver(now),
        denverTime: new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Denver",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).format(now),
        selectedDate: parsed.data.selectedDate,
        selectedStart: parsed.data.selectedSlots[0]?.startTime,
        minAllowedDate: minAllowed.dateStr,
        minAllowedMinutes: minAllowed.minutes,
    });
    const selectedStartMinutes = timeToMinutes(parsed.data.selectedSlots[0].startTime);
    if (parsed.data.selectedDate < minAllowed.dateStr) {
        return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }
    if (parsed.data.selectedDate === minAllowed.dateStr && selectedStartMinutes < minAllowed.minutes) {
        return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }
    if (!areSlotsContiguous(parsed.data.selectedSlots)) {
        return res.status(400).json({ message: "Selected slots must be consecutive." });
    }
    const orderedSlots = [...parsed.data.selectedSlots].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    const startAt = makeDateTime(parsed.data.selectedDate, orderedSlots[0].startTime);
    const endAt = makeDateTime(parsed.data.selectedDate, orderedSlots[orderedSlots.length - 1].endTime);
    const conflict = await prisma.pickupAppointment.findFirst({
        where: {
            id: { not: appointment.id },
            locationId: appointment.locationId,
            status: { in: [client_1.PickupAppointmentStatus.Scheduled, client_1.PickupAppointmentStatus.Confirmed] },
            startAt: { lt: endAt },
            endAt: { gt: startAt },
        },
        select: { id: true },
    });
    if (conflict) {
        return res.status(409).json({ message: "Time slot no longer available." });
    }
    const updated = await prisma.pickupAppointment.update({
        where: { id: appointment.id },
        data: {
            startAt,
            endAt,
            status: client_1.PickupAppointmentStatus.Scheduled,
        },
    });
    await (0, notifications_1.notifyAppointmentRescheduled)(prisma, updated, appointment.orders.map((o) => o.orderNbr), appointment.startAt, appointment.endAt, true);
    const activeToken = await (0, tokens_1.getActiveToken)(prisma, updated.id);
    const tokenRow = activeToken ?? (await (0, tokens_1.createAppointmentToken)(prisma, updated.id, updated.endAt));
    const link = (0, buildLink_1.buildAppointmentLink)(updated.id, tokenRow.token);
    return res.json({ appointment: updated, link });
});
