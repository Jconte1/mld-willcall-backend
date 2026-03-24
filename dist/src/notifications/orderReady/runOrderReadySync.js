"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrderReadySync = runOrderReadySync;
const client_1 = require("@prisma/client");
const fetchOrderReadyReport_1 = require("../../lib/acumatica/fetch/fetchOrderReadyReport");
const locationIds_1 = require("../../lib/locationIds");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const sendEmail_1 = require("../providers/email/sendEmail");
const sendSms_1 = require("../providers/sms/sendSms");
const buildOrderReadyEmail_1 = require("../templates/email/buildOrderReadyEmail");
const quietHours_1 = require("../rules/quietHours");
const buildSms_1 = require("../templates/sms/buildSms");
const orderDisplay_1 = require("./orderDisplay");
const orderNotificationLabel_1 = require("./orderNotificationLabel");
const DENVER_TZ = "America/Denver";
const JOB_NAME = "order-ready-daily";
const RESEND_DAYS = 1;
const RUN_HOUR = 9;
const RUN_MINUTE = 30;
const RUN_WINDOW_MINUTES = 12 * 60;
const ACTIVE_APPOINTMENT_STATUSES = [
    client_1.PickupAppointmentStatus.Scheduled,
    client_1.PickupAppointmentStatus.Confirmed,
    client_1.PickupAppointmentStatus.InProgress,
    client_1.PickupAppointmentStatus.Ready,
];
const JACKSON_SHIP_VIAS = new Set(["TRANS JACKSON", "WILL CALL JX"]);
const PROVO_SHIP_VIAS = new Set(["TRANS PROVO", "WILL CALL PR"]);
const JACKSON_WAREHOUSE = "JACKSON SHOWROOM";
const PROVO_WAREHOUSE = "PROVO SHOWROOM";
function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits || null;
}
function resolveOrderReadySmsPhone(row) {
    return normalizePhone(row.attributeSiteNumber) || normalizePhone(row.attributeSmsTxt);
}
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
function getAttemptDateKey(date) {
    return getDenverParts(date).date;
}
function buildSummaryKey(baid, orderNbr) {
    return `${String(baid ?? "").trim().toUpperCase()}::${orderNbr.trim().toUpperCase()}`;
}
function normalizeText(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}
function evaluateOrderReadyLocationEligibility(input) {
    const shipVia = normalizeText(input.shipVia);
    const warehouse = normalizeText(input.warehouse);
    if (JACKSON_SHIP_VIAS.has(shipVia)) {
        const ok = warehouse === JACKSON_WAREHOUSE;
        return {
            eligible: ok,
            reason: ok ? null : "jackson-shipvia-requires-jackson-showroom",
            specialTransit: "jackson",
        };
    }
    if (PROVO_SHIP_VIAS.has(shipVia)) {
        const ok = warehouse === PROVO_WAREHOUSE;
        return {
            eligible: ok,
            reason: ok ? null : "provo-shipvia-requires-provo-showroom",
            specialTransit: "provo",
        };
    }
    return {
        eligible: true,
        reason: null,
        specialTransit: null,
    };
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
    const minutesSinceStart = parts.hour * 60 + parts.minute - (RUN_HOUR * 60 + RUN_MINUTE);
    if (minutesSinceStart > RUN_WINDOW_MINUTES)
        return false;
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
    if (rows.length) {
        console.log("[order-ready] sample row", {
            orderNbr: rows[0]?.orderNbr,
            orderType: rows[0]?.orderType,
            status: rows[0]?.status,
            textNotification: rows[0]?.attributeSiteNumber ?? rows[0]?.attributeSmsTxt,
            emailNotification: rows[0]?.attributeEmailNoty,
            textOptIn: rows[0]?.attributeSmsOptIn,
            emailOptIn: rows[0]?.attributeEmailOptIn,
            salspersonnumber: rows[0]?.salspersonnumber,
            warehouse: rows[0]?.warehouse,
        });
    }
    const grouped = groupOrderReadyRows(rows);
    const seenOrderNbrs = new Set(Array.from(grouped.keys()));
    const summaryRows = await prisma.erpOrderSummary.findMany({
        where: {
            orderNbr: { in: Array.from(grouped.keys()) },
        },
        select: {
            baid: true,
            orderNbr: true,
            locationId: true,
            jobName: true,
            updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
    });
    const summaryByBaidAndOrder = new Map();
    const summaryByOrder = new Map();
    for (const summary of summaryRows) {
        const key = buildSummaryKey(summary.baid, summary.orderNbr);
        if (!summaryByBaidAndOrder.has(key))
            summaryByBaidAndOrder.set(key, summary);
        const orderKey = summary.orderNbr.trim().toUpperCase();
        if (!summaryByOrder.has(orderKey))
            summaryByOrder.set(orderKey, summary);
    }
    for (const [orderNbr, bucket] of grouped.entries()) {
        const row = bucket.row;
        const contactEmail = (row.attributeEmailNoty || "").trim() || null;
        const contactPhone = resolveOrderReadySmsPhone(row);
        const locationEligibility = evaluateOrderReadyLocationEligibility({
            shipVia: row.shipVia,
            warehouse: row.warehouse,
        });
        const mappedLocationId = (0, locationIds_1.normalizeWarehouseToLocationId)(row.warehouse);
        const locationId = locationEligibility.specialTransit != null
            ? mappedLocationId ?? null
            : mappedLocationId ?? "slc-hq";
        const summaryLookupKey = buildSummaryKey(row.customerId, orderNbr);
        const summary = summaryByBaidAndOrder.get(summaryLookupKey) ??
            summaryByOrder.get(orderNbr.trim().toUpperCase()) ??
            null;
        const jobDisplay = (0, orderDisplay_1.resolveOrderReadyJobDisplay)({
            locationId: summary?.locationId,
            jobName: summary?.jobName,
        });
        const smsOptIn = row.attributeSmsOptIn === true;
        const emailOptIn = row.attributeEmailOptIn === true;
        const smsEligible = locationEligibility.eligible && smsOptIn && Boolean(contactPhone);
        const emailEligible = locationEligibility.eligible && emailOptIn && Boolean(contactEmail);
        const existingNotice = await prisma.orderReadyNotice.findUnique({
            where: { orderNbr },
            select: {
                id: true,
                attributeSmsTxt: true,
                attributeEmailNoty: true,
                attributeSmsOptIn: true,
                attributeEmailOptIn: true,
                notifyAttemptCount: true,
                lastNotifyAttemptOn: true,
                lastNotifiedAt: true,
                nextEligibleNotifyAt: true,
                scheduledAppointmentId: true,
                smsOptIn: true,
                emailOptIn: true,
            },
        });
        const prevEmail = (existingNotice?.attributeEmailNoty || "").trim() || null;
        const prevPhone = normalizePhone(existingNotice?.attributeSmsTxt);
        const channelDestinationChanged = Boolean(existingNotice) && (prevEmail !== contactEmail || prevPhone !== contactPhone);
        const bothOptedOut = row.attributeSmsOptIn === false && row.attributeEmailOptIn === false;
        const wasPreviouslyEligible = Boolean(existingNotice?.smsOptIn || existingNotice?.emailOptIn);
        const becameIneligible = !locationEligibility.eligible && wasPreviouslyEligible;
        if (channelDestinationChanged) {
            console.log("[order-ready] attempt counter reset (contact change)", {
                orderNbr,
                prevEmail,
                nextEmail: contactEmail,
                prevPhone,
                nextPhone: contactPhone,
            });
        }
        if (bothOptedOut) {
            console.log("[order-ready] attempt counter primed (both channels opted out)", {
                orderNbr,
            });
        }
        const attemptResetData = channelDestinationChanged
            ? {
                notifyAttemptCount: 0,
                lastNotifyAttemptOn: null,
                escalationCount: 0,
                lastEscalatedAt: null,
            }
            : {};
        const bothOptedOutData = bothOptedOut
            ? {
                notifyAttemptCount: Math.max(existingNotice?.notifyAttemptCount ?? 0, 5),
                lastNotifyAttemptOn: null,
            }
            : {};
        const ineligibleResetData = becameIneligible
            ? {
                notifyAttemptCount: 0,
                lastNotifyAttemptOn: null,
                escalationCount: 0,
                lastEscalatedAt: null,
                nextEligibleNotifyAt: null,
            }
            : {};
        const nextEligibleOverride = locationEligibility.eligible && channelDestinationChanged && existingNotice?.lastNotifiedAt
            ? now
            : undefined;
        const updateData = {
            baid: row.customerId ?? null,
            status: row.status ?? null,
            orderType: row.orderType ?? null,
            shipVia: row.shipVia ?? null,
            qtyUnallocated: row.qtyUnallocated ?? null,
            qtyAllocated: row.qtyAllocated ?? null,
            customerId: row.customerId ?? null,
            customerIdDescription: row.customerIdDescription ?? null,
            salspersonnumber: row.salspersonnumber ?? null,
            customerLocationId: row.customerLocationId ?? null,
            attributeBuyerGroup: row.attributeBuyerGroup ?? null,
            attributeOsContact: row.attributeOsContact ?? null,
            attributeSiteNumber: row.attributeSiteNumber ?? null,
            attributeDelEmail: row.attributeDelEmail ?? null,
            attributeSmsTxt: row.attributeSmsTxt ?? null,
            attributeEmailNoty: row.attributeEmailNoty ?? null,
            attributeSmsOptIn: row.attributeSmsOptIn ?? null,
            attributeEmailOptIn: row.attributeEmailOptIn ?? null,
            contactName: row.attributeOsContact ?? null,
            contactPhone, // TODO: replace with actual contact phone field
            contactEmail,
            locationId,
            smsOptIn: smsEligible,
            emailOptIn: emailEligible,
            lastReadyAt: now,
            ...attemptResetData,
            ...bothOptedOutData,
            ...ineligibleResetData,
            ...(nextEligibleOverride ? { nextEligibleNotifyAt: nextEligibleOverride } : {}),
        };
        console.log("[order-ready] opt-in write attempt", {
            orderNbr,
            fetched: {
                attributeSmsOptIn: row.attributeSmsOptIn,
                attributeEmailOptIn: row.attributeEmailOptIn,
                attributeSmsTxt: row.attributeSmsTxt ?? null,
                attributeEmailNoty: row.attributeEmailNoty ?? null,
                salspersonnumber: row.salspersonnumber ?? null,
            },
            computed: {
                smsEligible,
                emailEligible,
                locationEligible: locationEligibility.eligible,
                locationEligibilityReason: locationEligibility.reason,
            },
            writePayload: {
                attributeSmsOptIn: updateData.attributeSmsOptIn,
                attributeEmailOptIn: updateData.attributeEmailOptIn,
                smsOptIn: updateData.smsOptIn,
                emailOptIn: updateData.emailOptIn,
                salspersonnumber: updateData.salspersonnumber,
            },
        });
        const createData = {
            orderNbr,
            baid: row.customerId ?? null,
            status: row.status ?? null,
            orderType: row.orderType ?? null,
            shipVia: row.shipVia ?? null,
            qtyUnallocated: row.qtyUnallocated ?? null,
            qtyAllocated: row.qtyAllocated ?? null,
            customerId: row.customerId ?? null,
            customerIdDescription: row.customerIdDescription ?? null,
            salspersonnumber: row.salspersonnumber ?? null,
            customerLocationId: row.customerLocationId ?? null,
            attributeBuyerGroup: row.attributeBuyerGroup ?? null,
            attributeOsContact: row.attributeOsContact ?? null,
            attributeSiteNumber: row.attributeSiteNumber ?? null,
            attributeDelEmail: row.attributeDelEmail ?? null,
            attributeSmsTxt: row.attributeSmsTxt ?? null,
            attributeEmailNoty: row.attributeEmailNoty ?? null,
            attributeSmsOptIn: row.attributeSmsOptIn ?? null,
            attributeEmailOptIn: row.attributeEmailOptIn ?? null,
            contactName: row.attributeOsContact ?? null,
            contactPhone, // TODO: replace with actual contact phone field
            contactEmail,
            locationId,
            smsOptIn: smsEligible,
            emailOptIn: emailEligible,
            lastReadyAt: now,
            notifyAttemptCount: bothOptedOut ? 5 : 0,
            lastNotifyAttemptOn: null,
            escalationCount: 0,
            lastEscalatedAt: null,
        };
        const notice = await prisma.orderReadyNotice.upsert({
            where: { orderNbr },
            update: updateData,
            create: createData,
        });
        console.log("[order-ready] opt-in write result", {
            orderNbr,
            written: {
                attributeSmsOptIn: notice.attributeSmsOptIn,
                attributeEmailOptIn: notice.attributeEmailOptIn,
                smsOptIn: notice.smsOptIn,
                emailOptIn: notice.emailOptIn,
                salspersonnumber: notice.salspersonnumber,
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
            await prisma.orderReadyNotice.update({
                where: { id: notice.id },
                data: {
                    notifyAttemptCount: 0,
                    lastNotifyAttemptOn: null,
                    escalationCount: 0,
                    lastEscalatedAt: null,
                },
            });
            console.log("[order-ready] attempt counter reset (order status)", {
                orderNbr,
                status: normalizedStatus,
            });
            continue;
        }
        const scheduledAppointment = await prisma.pickupAppointmentOrder.findFirst({
            where: {
                orderNbr,
                appointment: {
                    status: { in: ACTIVE_APPOINTMENT_STATUSES },
                },
            },
            include: { appointment: true },
            orderBy: { appointment: { startAt: "desc" } },
        });
        if (scheduledAppointment?.appointmentId) {
            await prisma.orderReadyNotice.update({
                where: { id: notice.id },
                data: {
                    scheduledAppointmentId: scheduledAppointment.appointmentId,
                    notifyAttemptCount: 0,
                    lastNotifyAttemptOn: null,
                    escalationCount: 0,
                    lastEscalatedAt: null,
                },
            });
            console.log("[order-ready] attempt counter reset (active appointment)", {
                orderNbr,
                appointmentId: scheduledAppointment.appointmentId,
            });
            continue;
        }
        if (notice.scheduledAppointmentId) {
            await prisma.orderReadyNotice.update({
                where: { id: notice.id },
                data: { scheduledAppointmentId: null },
            });
        }
        if (!locationEligibility.eligible) {
            console.log("[order-ready] skipped (location eligibility)", {
                orderNbr,
                shipVia: row.shipVia ?? null,
                warehouse: row.warehouse ?? null,
                mappedLocationId: mappedLocationId ?? null,
                reason: locationEligibility.reason,
                becameIneligible,
            });
            continue;
        }
        const eligible = !notice.lastNotifiedAt ||
            (notice.nextEligibleNotifyAt && notice.nextEligibleNotifyAt <= now);
        if (!eligible)
            continue;
        const activeToken = await (0, tokens_1.getActiveOrderReadyToken)(prisma, notice.id);
        const tokenRow = activeToken ?? (await (0, tokens_1.createOrderReadyToken)(prisma, notice.id));
        const link = (0, buildLink_1.buildOrderReadyLink)(orderNbr, tokenRow.token);
        const sendAt = (0, quietHours_1.nextAllowedTime)(now);
        if (sendAt.getTime() > now.getTime()) {
            console.log("[order-ready] deferred (quiet hours)", { orderNbr, sendAt: sendAt.toISOString() });
            continue;
        }
        let sentEmail = false;
        let sentSms = false;
        if (notice.emailOptIn) {
            const orderLabel = (0, orderNotificationLabel_1.buildOrderNotificationLabel)({
                orderNbr,
                buyerGroup: notice.attributeBuyerGroup,
                customerLocationId: notice.customerLocationId,
                customerIdDescription: notice.customerIdDescription,
                jobDisplay,
            });
            const message = (0, buildOrderReadyEmail_1.buildOrderReadyEmail)(orderNbr, link, {
                orderLabel,
                jobDisplay,
            });
            const recipient = notice.contactEmail || "";
            if (!recipient) {
                console.log("[order-ready] email skipped (missing recipient)", { orderNbr });
            }
            else {
                console.log("[order-ready] email context", {
                    orderNbr,
                    summaryLocationId: summary?.locationId ?? null,
                    summaryJobName: summary?.jobName ?? null,
                    resolvedJobDisplay: jobDisplay,
                    subject: message.subject,
                });
                await (0, sendEmail_1.sendEmail)(recipient, message.subject, message.body, { allowTestOverride: false });
                sentEmail = true;
            }
        }
        else {
            console.log("[order-ready] email skipped (email opt-in false)", { orderNbr });
        }
        if (notice.smsOptIn && !notice.smsOptOutAt && notice.contactPhone) {
            const orderLabel = (0, orderNotificationLabel_1.buildOrderNotificationLabel)({
                orderNbr,
                buyerGroup: notice.attributeBuyerGroup,
                customerLocationId: notice.customerLocationId,
                customerIdDescription: notice.customerIdDescription,
                jobDisplay,
            });
            const smsBase = `MLD Will Call: ${orderLabel} is ready for pickup. Schedule here: ${link}`;
            const includeStopLine = !notice.smsFirstSentAt;
            const smsBody = (0, buildSms_1.applySmsCompliance)(smsBase, includeStopLine);
            await (0, sendSms_1.sendSms)(notice.contactPhone, smsBody, { allowTestOverride: false });
            sentSms = true;
            if (!notice.smsFirstSentAt) {
                await prisma.orderReadyNotice.update({
                    where: { id: notice.id },
                    data: { smsFirstSentAt: new Date() },
                });
            }
        }
        else if (!notice.smsOptIn) {
            console.log("[order-ready] sms skipped (sms opt-in false)", { orderNbr });
        }
        const sentAny = sentEmail || sentSms;
        if (!sentAny) {
            console.log("[order-ready] no customer notification sent", { orderNbr });
            continue;
        }
        const attemptDay = getAttemptDateKey(now);
        const alreadyCountedToday = notice.lastNotifyAttemptOn === attemptDay;
        const currentAttempts = notice.notifyAttemptCount ?? 0;
        const nextAttempts = alreadyCountedToday ? currentAttempts : currentAttempts + 1;
        await prisma.orderReadyNotice.update({
            where: { id: notice.id },
            data: {
                lastNotifiedAt: now,
                nextEligibleNotifyAt: addDays(now, RESEND_DAYS),
                lastNotifyAttemptOn: attemptDay,
                notifyAttemptCount: nextAttempts,
            },
        });
        console.log("[order-ready] notified", {
            orderNbr,
            sentEmail,
            sentSms,
            attemptDay,
            alreadyCountedToday,
            notifyAttemptCount: nextAttempts,
        });
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
                scheduledAppointmentId: null,
                notifyAttemptCount: 0,
                lastNotifyAttemptOn: null,
                escalationCount: 0,
                lastEscalatedAt: null,
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
