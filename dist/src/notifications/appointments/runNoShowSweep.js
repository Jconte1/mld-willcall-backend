"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runNoShowSweep = runNoShowSweep;
const client_1 = require("@prisma/client");
const format_1 = require("../format");
const sendEmail_1 = require("../providers/email/sendEmail");
const sendSms_1 = require("../providers/sms/sendSms");
const cancelJobs_1 = require("../scheduler/cancelJobs");
const buildNoShowEmail_1 = require("../templates/email/buildNoShowEmail");
const denver_1 = require("../../lib/time/denver");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const pickupLocations_1 = require("../../lib/pickupLocations");
const orderDisplay_1 = require("../orderReady/orderDisplay");
const orderNotificationLabel_1 = require("../orderReady/orderNotificationLabel");
const DENVER_TZ = "America/Denver";
const JOB_NAME = "appointment-no-show-sweep";
const RUN_HOUR = 17;
const RUN_MINUTE = 15;
const RUN_WINDOW_MINUTES = 30;
const ACTIVE_STATUSES = [
    client_1.PickupAppointmentStatus.Scheduled,
    client_1.PickupAppointmentStatus.Confirmed,
    client_1.PickupAppointmentStatus.InProgress,
    client_1.PickupAppointmentStatus.Ready,
    client_1.PickupAppointmentStatus.NoShow,
];
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
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        hour: Number(get("hour")),
        minute: Number(get("minute")),
    };
}
async function shouldRun(prisma, now) {
    const parts = getDenverParts(now);
    if (parts.hour < RUN_HOUR || (parts.hour === RUN_HOUR && parts.minute < RUN_MINUTE))
        return false;
    const minutesSinceStart = (parts.hour * 60 + parts.minute) - (RUN_HOUR * 60 + RUN_MINUTE);
    if (minutesSinceStart > RUN_WINDOW_MINUTES)
        return false;
    const existing = await prisma.orderReadyJobState.findUnique({
        where: { name: JOB_NAME },
    });
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
async function sendNoShowNotifications(prisma, appointment) {
    const when = (0, format_1.formatDenverDateTime)(appointment.startAt);
    const orderNbrs = Array.from(new Set(appointment.orders.map((o) => String(o.orderNbr || "").trim()).filter(Boolean)));
    const orderList = (0, format_1.formatOrderList)(orderNbrs);
    const location = (0, pickupLocations_1.getPickupLocation)(appointment.locationId);
    const summaries = orderNbrs.length
        ? await prisma.erpOrderSummary.findMany({
            where: {
                orderNbr: { in: orderNbrs },
                isActive: true,
            },
            select: {
                orderNbr: true,
                locationId: true,
                jobName: true,
                updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
        })
        : [];
    const notices = orderNbrs.length
        ? await prisma.orderReadyNotice.findMany({
            where: { orderNbr: { in: orderNbrs } },
            select: {
                orderNbr: true,
                attributeBuyerGroup: true,
                customerLocationId: true,
                customerIdDescription: true,
            },
        })
        : [];
    const summaryByOrderNbr = new Map();
    for (const summary of summaries) {
        const key = summary.orderNbr.trim().toUpperCase();
        if (!summaryByOrderNbr.has(key))
            summaryByOrderNbr.set(key, summary);
    }
    const noticeByOrderNbr = new Map();
    for (const notice of notices) {
        const key = notice.orderNbr.trim().toUpperCase();
        if (!noticeByOrderNbr.has(key))
            noticeByOrderNbr.set(key, notice);
    }
    const orderDisplays = orderNbrs.map((orderNbr) => {
        const summary = summaryByOrderNbr.get(orderNbr.trim().toUpperCase());
        const notice = noticeByOrderNbr.get(orderNbr.trim().toUpperCase());
        const jobDisplay = (0, orderDisplay_1.resolveOrderReadyJobDisplay)({
            locationId: summary?.locationId,
            jobName: summary?.jobName,
        });
        return (0, orderNotificationLabel_1.buildOrderNotificationLabel)({
            orderNbr,
            buyerGroup: notice?.attributeBuyerGroup,
            customerLocationId: notice?.customerLocationId,
            customerIdDescription: notice?.customerIdDescription,
            jobDisplay,
        });
    });
    const token = await (0, tokens_1.rotateAppointmentToken)(prisma, appointment.id, appointment.endAt);
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    if (appointment.emailOptIn && !appointment.noShowEmailAttemptedAt) {
        const recipient = appointment.emailOptInEmail || appointment.customerEmail;
        const message = (0, buildNoShowEmail_1.buildNoShowEmail)({
            when,
            orderDisplays,
            link,
            locationName: location?.name ?? appointment.locationId,
            locationAddress: location?.address,
        });
        const attemptedAt = new Date();
        await prisma.pickupAppointment.update({
            where: { id: appointment.id },
            data: { noShowEmailAttemptedAt: attemptedAt },
        });
        await (0, sendEmail_1.sendEmail)(recipient, message.subject, message.body, { allowTestOverride: false });
        await prisma.pickupAppointment.update({
            where: { id: appointment.id },
            data: { noShowEmailSentAt: new Date() },
        });
    }
    if (appointment.smsOptIn && !appointment.noShowSmsAttemptedAt) {
        const smsTo = appointment.smsOptInPhone || appointment.customerPhone || "";
        if (smsTo) {
            await prisma.pickupAppointment.update({
                where: { id: appointment.id },
                data: { noShowSmsAttemptedAt: new Date() },
            });
            const smsBody = `We missed you at your pickup on ${when}. ${orderList} Your items are being returned to stock. Please reschedule ASAP. Manage: ${link}`;
            await (0, sendSms_1.sendSms)(smsTo, smsBody, { allowTestOverride: false });
        }
    }
}
async function runNoShowSweep(prisma) {
    const now = new Date();
    if (!(await shouldRun(prisma, now)))
        return;
    const startOfToday = (0, denver_1.startOfDayDenver)(now);
    const appointments = await prisma.pickupAppointment.findMany({
        where: {
            status: { in: ACTIVE_STATUSES },
            noShowNotificationProcessedAt: null,
            endAt: { gte: startOfToday, lt: now },
        },
        include: { orders: true },
    });
    if (!appointments.length) {
        await markRun(prisma, now);
        return;
    }
    for (const appointment of appointments) {
        try {
            const updated = appointment.status === client_1.PickupAppointmentStatus.NoShow
                ? appointment
                : await prisma.pickupAppointment.update({
                    where: { id: appointment.id },
                    data: { status: client_1.PickupAppointmentStatus.NoShow },
                });
            await (0, cancelJobs_1.cancelPendingJobs)(prisma, updated.id);
            if (appointment.orders.length) {
                await prisma.orderReadyNotice.updateMany({
                    where: { orderNbr: { in: appointment.orders.map((order) => order.orderNbr) } },
                    data: { scheduledAppointmentId: null },
                });
            }
            try {
                await sendNoShowNotifications(prisma, {
                    id: updated.id,
                    startAt: updated.startAt,
                    endAt: updated.endAt,
                    locationId: updated.locationId,
                    emailOptIn: updated.emailOptIn,
                    emailOptInEmail: updated.emailOptInEmail,
                    customerEmail: updated.customerEmail,
                    smsOptIn: updated.smsOptIn,
                    smsOptInPhone: updated.smsOptInPhone,
                    customerPhone: updated.customerPhone,
                    orders: appointment.orders,
                    noShowEmailAttemptedAt: updated.noShowEmailAttemptedAt,
                    noShowSmsAttemptedAt: updated.noShowSmsAttemptedAt,
                });
            }
            catch (err) {
                console.error("[appointments] no-show notification failed", {
                    appointmentId: appointment.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            await prisma.pickupAppointment.update({
                where: { id: appointment.id },
                data: { noShowNotificationProcessedAt: new Date() },
            });
        }
        catch (err) {
            console.error("[appointments] no-show prep failed", {
                appointmentId: appointment.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    await markRun(prisma, now);
    console.log("[appointments] no-show sweep", { count: appointments.length });
}
