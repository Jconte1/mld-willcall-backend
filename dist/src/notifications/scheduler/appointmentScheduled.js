"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAppointmentScheduled = handleAppointmentScheduled;
const client_1 = require("@prisma/client");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const eligibility_1 = require("../rules/eligibility");
const computeReminderTimes_1 = require("./computeReminderTimes");
const enqueueJob_1 = require("../jobs/enqueueJob");
const sendImmediate_1 = require("./sendImmediate");
async function handleAppointmentScheduled(prisma, input) {
    const now = new Date();
    const { appointment, orderNbrs, staffCreated, ignoreCap } = input;
    console.log("[notifications] scheduled", {
        appointmentId: appointment.id,
        staffCreated,
        orderCount: orderNbrs.length,
    });
    if (!ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, appointment.id)))
        return;
    if ((0, eligibility_1.shouldSkipForQuietHours)(now))
        return;
    const token = await (0, tokens_1.createAppointmentToken)(prisma, appointment.id, appointment.endAt);
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.ScheduledConfirm, {
        link,
        orderNbrs,
        staffInitiated: Boolean(staffCreated),
    }, undefined, Boolean(ignoreCap));
    const reminders = (0, computeReminderTimes_1.computeReminderTimes)(appointment.startAt, now);
    if (reminders.oneHourAt) {
        await (0, enqueueJob_1.enqueueJob)(prisma, {
            appointmentId: appointment.id,
            type: client_1.AppointmentNotificationType.Reminder1Hour,
            scheduledAt: reminders.oneHourAt,
            payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
        });
    }
    else if (reminders.sendOneHourImmediately) {
        await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.Reminder1Hour, { link, orderNbrs }, undefined, Boolean(ignoreCap));
    }
    if (!staffCreated && reminders.oneDayAt) {
        await (0, enqueueJob_1.enqueueJob)(prisma, {
            appointmentId: appointment.id,
            type: client_1.AppointmentNotificationType.Reminder1Day,
            scheduledAt: reminders.oneDayAt,
            payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
        });
    }
}
