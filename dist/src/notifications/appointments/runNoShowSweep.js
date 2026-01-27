"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runNoShowSweep = runNoShowSweep;
const client_1 = require("@prisma/client");
const format_1 = require("../format");
const sendEmail_1 = require("../providers/email/sendEmail");
const sendSms_1 = require("../providers/sms/sendSms");
const cancelJobs_1 = require("../scheduler/cancelJobs");
const DENVER_TZ = "America/Denver";
const JOB_NAME = "appointment-no-show-sweep";
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
    if (parts.hour < 17 || (parts.hour === 17 && parts.minute < 15))
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
async function sendNoShowNotifications(appointment) {
    const when = (0, format_1.formatDenverDateTime)(appointment.startAt);
    const orderList = (0, format_1.formatOrderList)(appointment.orders.map((o) => o.orderNbr));
    if (appointment.emailOptIn) {
        const recipient = appointment.emailOptInEmail || appointment.customerEmail;
        const subject = "We missed you at pickup";
        const body = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2 style="margin: 0 0 12px;">We missed you</h2>
        <p style="margin: 0 0 12px;">
          We didn't see you at your pickup scheduled for ${when}.
        </p>
        <p style="margin: 0 0 12px;">${orderList}</p>
        <p style="margin: 0;">
          Please visit our site to reschedule your pickup.
        </p>
      </div>
    `;
        await (0, sendEmail_1.sendEmail)(recipient, subject, body);
    }
    if (appointment.smsOptIn) {
        const smsTo = appointment.smsOptInPhone || appointment.customerPhone || "";
        if (smsTo) {
            const smsBody = `We missed you at your pickup on ${when}. ${orderList} Please reschedule when ready.`;
            await (0, sendSms_1.sendSms)(smsTo, smsBody);
        }
    }
}
async function runNoShowSweep(prisma) {
    const now = new Date();
    if (!(await shouldRun(prisma, now)))
        return;
    const appointments = await prisma.pickupAppointment.findMany({
        where: {
            status: { in: ACTIVE_STATUSES },
            endAt: { lt: now },
        },
        include: { orders: true },
    });
    if (!appointments.length) {
        await markRun(prisma, now);
        return;
    }
    for (const appointment of appointments) {
        const updated = appointment.status === client_1.PickupAppointmentStatus.NoShow
            ? appointment
            : await prisma.pickupAppointment.update({
                where: { id: appointment.id },
                data: { status: client_1.PickupAppointmentStatus.NoShow },
            });
        await (0, cancelJobs_1.cancelPendingJobs)(prisma, updated.id);
        await sendNoShowNotifications({
            id: updated.id,
            startAt: updated.startAt,
            endAt: updated.endAt,
            emailOptIn: updated.emailOptIn,
            emailOptInEmail: updated.emailOptInEmail,
            customerEmail: updated.customerEmail,
            smsOptIn: updated.smsOptIn,
            smsOptInPhone: updated.smsOptInPhone,
            customerPhone: updated.customerPhone,
            orders: appointment.orders,
        });
    }
    await markRun(prisma, now);
    console.log("[appointments] no-show sweep", { count: appointments.length });
}
