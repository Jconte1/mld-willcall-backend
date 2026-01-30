"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrderReadySync = runOrderReadySync;
const fetchOrderReadyReport_1 = require("../../lib/acumatica/fetch/fetchOrderReadyReport");
const locationIds_1 = require("../../lib/locationIds");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const sendEmail_1 = require("../providers/email/sendEmail");
const buildOrderReadyEmail_1 = require("../templates/email/buildOrderReadyEmail");
const DENVER_TZ = "America/Denver";
const JOB_NAME = "order-ready-daily";
const RESEND_DAYS = 1;
const MAX_SEND_PER_RUN = 3; // TODO: Remove send restriction for live production.
const RUN_HOUR = 9;
const RUN_MINUTE = 30;
function getDenverParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        hour: Number(get("hour")),
        minute: Number(get("minute")),
        weekday: new Intl.DateTimeFormat("en-US", { timeZone: DENVER_TZ, weekday: "short" }).format(date),
    };
}
function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
async function shouldRun(prisma, now) {
    const existing = await prisma.orderReadyJobState.findUnique({
        where: { name: JOB_NAME },
    });
    const parts = getDenverParts(now);
    if (parts.weekday === "Sat" || parts.weekday === "Sun")
        return false;
    if (parts.hour < RUN_HOUR || (parts.hour === RUN_HOUR && parts.minute < RUN_MINUTE)) {
        return false;
    }
    if (!existing?.lastRunAt)
        return true;
    const last = getDenverParts(existing.lastRunAt);
    return last.date !== parts.date;
}
async function markRun(prisma, now) {
    await prisma.orderReadyJobState.upsert({
        where: { name: JOB_NAME },
        update: { lastRunAt: now },
        create: { name: JOB_NAME, lastRunAt: now },
    });
}
async function runOrderReadySync(prisma) {
    const now = new Date();
    if (!(await shouldRun(prisma, now)))
        return;
    console.log("[order-ready] running daily sync");
    const rows = await (0, fetchOrderReadyReport_1.fetchOrderReadyReport)();
    console.log("[order-ready] rows fetched", { count: rows.length });
    const grouped = groupOrderReadyRows(rows);
    const seenOrderNbrs = new Set(Array.from(grouped.keys()));
    let sentCount = 0;
    for (const [orderNbr, bucket] of grouped.entries()) {
        const row = bucket.row;
        const contactEmail = (row.attributeDelEmail || "").trim() || null;
        const mappedLocationId = (0, locationIds_1.normalizeWarehouseToLocationId)(row.warehouse);
        const locationId = mappedLocationId ?? "slc-hq";
        const notice = await prisma.orderReadyNotice.upsert({
            where: { orderNbr },
            update: {
                baid: row.customerId ?? null,
                status: row.status ?? null,
                orderType: row.orderType ?? null,
                shipVia: row.shipVia ?? null,
                qtyUnallocated: row.qtyUnallocated ?? null,
                qtyAllocated: row.qtyAllocated ?? null,
                customerId: row.customerId ?? null,
                customerLocationId: row.customerLocationId ?? null,
                attributeBuyerGroup: row.attributeBuyerGroup ?? null,
                attributeOsContact: row.attributeOsContact ?? null,
                attributeSiteNumber: row.attributeSiteNumber ?? null,
                attributeDelEmail: row.attributeDelEmail ?? null,
                contactName: row.attributeSiteNumber ?? null, // TODO: replace with actual contact name field
                contactPhone: row.attributeSiteNumber ?? null, // TODO: replace with actual contact phone field
                contactEmail,
                locationId,
                smsOptIn: false, // TODO: replace with actual opt-in field
                lastReadyAt: now,
            },
            create: {
                orderNbr,
                baid: row.customerId ?? null,
                status: row.status ?? null,
                orderType: row.orderType ?? null,
                shipVia: row.shipVia ?? null,
                qtyUnallocated: row.qtyUnallocated ?? null,
                qtyAllocated: row.qtyAllocated ?? null,
                customerId: row.customerId ?? null,
                customerLocationId: row.customerLocationId ?? null,
                attributeBuyerGroup: row.attributeBuyerGroup ?? null,
                attributeOsContact: row.attributeOsContact ?? null,
                attributeSiteNumber: row.attributeSiteNumber ?? null,
                attributeDelEmail: row.attributeDelEmail ?? null,
                contactName: row.attributeSiteNumber ?? null, // TODO: replace with actual contact name field
                contactPhone: row.attributeSiteNumber ?? null, // TODO: replace with actual contact phone field
                contactEmail,
                locationId,
                smsOptIn: false, // TODO: replace with actual opt-in field
                lastReadyAt: now,
            },
        });
        await prisma.orderReadyLine.deleteMany({ where: { orderReadyId: notice.id } });
        if (bucket.inventoryIds.size) {
            await prisma.orderReadyLine.createMany({
                data: Array.from(bucket.inventoryIds).map((inventoryId) => ({
                    orderReadyId: notice.id,
                    orderNbr,
                    inventoryId,
                })),
                skipDuplicates: true,
            });
        }
        const normalizedStatus = (notice.status || "").toLowerCase();
        if (normalizedStatus === "scheduled" || normalizedStatus === "completed") {
            continue;
        }
        const scheduledAppointment = await prisma.pickupAppointmentOrder.findFirst({
            where: {
                orderNbr,
                appointment: {
                    status: { in: ["Scheduled", "Confirmed", "InProgress", "Ready", "Completed"] },
                },
            },
            include: { appointment: true },
            orderBy: { appointment: { startAt: "desc" } },
        });
        if (scheduledAppointment?.appointmentId) {
            await prisma.orderReadyNotice.update({
                where: { id: notice.id },
                data: { scheduledAppointmentId: scheduledAppointment.appointmentId },
            });
            continue;
        }
        const eligible = !notice.lastNotifiedAt ||
            (notice.nextEligibleNotifyAt && notice.nextEligibleNotifyAt <= now);
        if (!eligible)
            continue;
        if (!notice.contactEmail && !process.env.NOTIFICATIONS_TEST_EMAIL) {
            // TODO: When production-ready, require a real contactEmail before sending.
            console.log("[order-ready] skipped (missing email)", { orderNbr });
            continue;
        }
        const activeToken = await (0, tokens_1.getActiveOrderReadyToken)(prisma, notice.id);
        const tokenRow = activeToken ?? (await (0, tokens_1.createOrderReadyToken)(prisma, notice.id));
        const link = (0, buildLink_1.buildOrderReadyLink)(orderNbr, tokenRow.token);
        const message = (0, buildOrderReadyEmail_1.buildOrderReadyEmail)(orderNbr, link);
        const recipient = notice.contactEmail || process.env.NOTIFICATIONS_TEST_EMAIL || "";
        if (!recipient) {
            console.log("[order-ready] skipped (missing recipient)", { orderNbr });
            continue;
        }
        if (sentCount >= MAX_SEND_PER_RUN) {
            console.log("[order-ready] email suppressed (limit reached)", { orderNbr });
            continue;
        }
        await (0, sendEmail_1.sendEmail)(recipient, message.subject, message.body);
        sentCount += 1;
        // TODO: After 5 consecutive daily sends, escalate to the salesperson for follow-up.
        await prisma.orderReadyNotice.update({
            where: { id: notice.id },
            data: {
                lastNotifiedAt: now,
                nextEligibleNotifyAt: addDays(now, RESEND_DAYS),
            },
        });
        console.log("[order-ready] notified", { orderNbr });
    }
    const staleNotices = await prisma.orderReadyNotice.findMany({
        where: { orderNbr: { notIn: Array.from(seenOrderNbrs) } },
        select: { id: true, orderNbr: true },
    });
    if (staleNotices.length) {
        await prisma.orderReadyNotice.updateMany({
            where: { id: { in: staleNotices.map((notice) => notice.id) } },
            data: {
                status: "NotReady",
                nextEligibleNotifyAt: null,
            },
        });
        await prisma.orderReadyLine.deleteMany({
            where: { orderReadyId: { in: staleNotices.map((notice) => notice.id) } },
        });
        await prisma.orderReadyAccessToken.updateMany({
            where: { orderReadyId: { in: staleNotices.map((notice) => notice.id) }, revokedAt: null },
            data: { revokedAt: now },
        });
        console.log("[order-ready] marked not-ready", { count: staleNotices.length });
    }
    await markRun(prisma, now);
}
function groupOrderReadyRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
        if (!row.orderNbr)
            continue;
        const orderNbr = row.orderNbr.trim();
        if (!orderNbr)
            continue;
        const existing = grouped.get(orderNbr);
        const inventoryId = row.inventoryId ? String(row.inventoryId).trim() : "";
        if (existing) {
            if (inventoryId)
                existing.inventoryIds.add(inventoryId);
        }
        else {
            grouped.set(orderNbr, {
                row,
                inventoryIds: inventoryId ? new Set([inventoryId]) : new Set(),
            });
        }
    }
    return grouped;
}
