"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAppointmentRescheduled = handleAppointmentRescheduled;
const client_1 = require("@prisma/client");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const eligibility_1 = require("../rules/eligibility");
const computeReminderTimes_1 = require("./computeReminderTimes");
const cancelJobs_1 = require("./cancelJobs");
const enqueueJob_1 = require("../jobs/enqueueJob");
const sendImmediate_1 = require("./sendImmediate");
async function handleAppointmentRescheduled(prisma, input) {
    const now = new Date();
    const { appointment, orderNbrs, oldStartAt, oldEndAt, ignoreCap, staffInitiated } = input;
    console.log("[notifications] rescheduled", {
        appointmentId: appointment.id,
        oldStartAt: oldStartAt.toISOString(),
        newStartAt: appointment.startAt.toISOString(),
    });
    await (0, cancelJobs_1.cancelPendingJobs)(prisma, appointment.id);
    const activeToken = await (0, tokens_1.getActiveToken)(prisma, appointment.id);
    const token = activeToken ?? (await (0, tokens_1.createAppointmentToken)(prisma, appointment.id, appointment.endAt));
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    const capReached = !ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, appointment.id));
    if (!(0, eligibility_1.shouldSkipForQuietHours)(now) && !capReached) {
        await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.Rescheduled, {
            link,
            orderNbrs,
            oldStartAt: oldStartAt.toISOString(),
            oldEndAt: oldEndAt.toISOString(),
            staffInitiated: Boolean(staffInitiated),
        }, undefined, Boolean(ignoreCap));
    }
    const reminders = (0, computeReminderTimes_1.computeReminderTimes)(appointment.startAt, now);
    if (reminders.oneHourAt) {
        await (0, enqueueJob_1.enqueueJob)(prisma, {
            appointmentId: appointment.id,
            type: client_1.AppointmentNotificationType.Reminder1Hour,
            scheduledAt: reminders.oneHourAt,
            payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
        });
    }
    else if (reminders.sendOneHourImmediately && !(0, eligibility_1.shouldSkipForQuietHours)(now)) {
        await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.Reminder1Hour, { link, orderNbrs }, undefined, Boolean(ignoreCap));
    }
    if (reminders.oneDayAt) {
        await (0, enqueueJob_1.enqueueJob)(prisma, {
            appointmentId: appointment.id,
            type: client_1.AppointmentNotificationType.Reminder1Day,
            scheduledAt: reminders.oneDayAt,
            payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
        });
    }
}
