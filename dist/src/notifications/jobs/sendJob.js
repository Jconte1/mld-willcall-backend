"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendJob = sendJob;
const client_1 = require("@prisma/client");
const buildSms_1 = require("../templates/sms/buildSms");
const buildEmail_1 = require("../templates/email/buildEmail");
const sendSms_1 = require("../providers/sms/sendSms");
const sendEmail_1 = require("../providers/email/sendEmail");
const buildLink_1 = require("../links/buildLink");
const pickupLocations_1 = require("../../lib/pickupLocations");
const orderDisplay_1 = require("../orderReady/orderDisplay");
const orderNotificationLabel_1 = require("../orderReady/orderNotificationLabel");
function normalizeOrderNbrs(input) {
    if (!Array.isArray(input))
        return [];
    return Array.from(new Set(input.map((v) => String(v || "").trim()).filter(Boolean)));
}
async function buildPayload(prisma, appointment, job, link) {
    const snapshot = (job.payloadSnapshot || {});
    const fallbackOrderNbrs = appointment.orders?.map((o) => o.orderNbr) ?? [];
    const normalizedOrderNbrs = normalizeOrderNbrs(snapshot.orderNbrs ?? fallbackOrderNbrs);
    const summaries = normalizedOrderNbrs.length
        ? await prisma.erpOrderSummary.findMany({
            where: {
                orderNbr: { in: normalizedOrderNbrs },
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
    const orderReadyNotices = normalizedOrderNbrs.length
        ? await prisma.orderReadyNotice.findMany({
            where: {
                orderNbr: { in: normalizedOrderNbrs },
            },
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
    for (const notice of orderReadyNotices) {
        const key = notice.orderNbr.trim().toUpperCase();
        if (!noticeByOrderNbr.has(key))
            noticeByOrderNbr.set(key, notice);
    }
    const orderDisplays = normalizedOrderNbrs.map((orderNbr) => {
        const notice = noticeByOrderNbr.get(orderNbr.trim().toUpperCase());
        const summary = summaryByOrderNbr.get(orderNbr.trim().toUpperCase());
        const jobDisplay = (0, orderDisplay_1.resolveOrderReadyJobDisplay)({
            locationId: summary?.locationId,
            jobName: summary?.jobName,
        });
        const label = (0, orderNotificationLabel_1.buildOrderNotificationLabel)({
            orderNbr,
            buyerGroup: notice?.attributeBuyerGroup,
            customerLocationId: notice?.customerLocationId,
            customerIdDescription: notice?.customerIdDescription,
            jobDisplay,
        });
        return {
            orderNbr,
            label,
            jobDisplay,
        };
    });
    const unsubscribeLink = snapshot.unsubscribeLink || buildUnsubscribeFromLink(link, appointment.id);
    const location = (0, pickupLocations_1.getPickupLocation)(appointment.locationId);
    const locationName = location?.name ?? appointment.locationId;
    return {
        appointmentId: appointment.id,
        locationId: appointment.locationId,
        locationName,
        locationAddress: location?.address,
        locationInstructions: location?.instructions,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        orderNbrs: normalizedOrderNbrs,
        orderDisplays,
        link,
        unsubscribeLink: unsubscribeLink || undefined,
        oldStartAt: snapshot.oldStartAt ? new Date(snapshot.oldStartAt) : undefined,
        oldEndAt: snapshot.oldEndAt ? new Date(snapshot.oldEndAt) : undefined,
        cancelReason: snapshot.cancelReason ?? null,
        staffInitiated: Boolean(snapshot.staffInitiated),
    };
}
function buildUnsubscribeFromLink(link, appointmentId) {
    try {
        const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "http://localhost";
        const url = new URL(link, base);
        const token = url.searchParams.get("token");
        if (!token)
            return "";
        return (0, buildLink_1.buildUnsubscribeLink)(appointmentId, token);
    }
    catch {
        return "";
    }
}
async function sendJob(prisma, job, appointment) {
    const link = job.payloadSnapshot?.link;
    if (!link) {
        throw new Error(`Missing secure link for notification job ${job.id}`);
    }
    const payload = await buildPayload(prisma, appointment, job, link);
    try {
        console.log("[notifications] sendJob", {
            id: job.id,
            type: job.type,
            channel: job.channel,
            appointmentId: appointment.id,
        });
        if (job.channel === client_1.NotificationChannel.SMS || job.channel === client_1.NotificationChannel.Both) {
            if (appointment.smsOptIn &&
                !appointment.smsOptOutAt &&
                (appointment.smsOptInPhone || appointment.customerPhone)) {
                const sms = (0, buildSms_1.buildSmsMessage)(job.type, payload);
                const includeStopLine = !appointment.smsFirstSentAt;
                const smsBody = (0, buildSms_1.applySmsCompliance)(sms, includeStopLine);
                const smsTo = appointment.smsOptInPhone || appointment.customerPhone;
                await (0, sendSms_1.sendSms)(smsTo, smsBody, { allowTestOverride: false });
                if (!appointment.smsFirstSentAt) {
                    await prisma.pickupAppointment.update({
                        where: { id: appointment.id },
                        data: { smsFirstSentAt: new Date() },
                    });
                }
            }
        }
        if (job.channel === client_1.NotificationChannel.Email || job.channel === client_1.NotificationChannel.Both) {
            if (appointment.emailOptIn && (appointment.emailOptInEmail || appointment.customerEmail)) {
                const email = (0, buildEmail_1.buildEmailMessage)(job.type, payload);
                const emailTo = appointment.emailOptInEmail || appointment.customerEmail;
                await (0, sendEmail_1.sendEmail)(emailTo, email.subject, email.body, { allowTestOverride: false });
            }
        }
        await prisma.appointmentNotificationJob.update({
            where: { id: job.id },
            data: {
                status: client_1.NotificationJobStatus.Sent,
                sentAt: new Date(),
                attemptCount: { increment: 1 },
                lastAttemptAt: new Date(),
            },
        });
    }
    catch (err) {
        console.error("[notifications] sendJob failed", err);
        await prisma.appointmentNotificationJob.update({
            where: { id: job.id },
            data: {
                status: client_1.NotificationJobStatus.Failed,
                attemptCount: { increment: 1 },
                lastAttemptAt: new Date(),
            },
        });
        throw err;
    }
}
