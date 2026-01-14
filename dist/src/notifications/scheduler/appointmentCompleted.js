"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAppointmentCompleted = handleAppointmentCompleted;
const client_1 = require("@prisma/client");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const eligibility_1 = require("../rules/eligibility");
const cancelJobs_1 = require("./cancelJobs");
const sendImmediate_1 = require("./sendImmediate");
async function handleAppointmentCompleted(prisma, input) {
    const now = new Date();
    const { appointment, orderNbrs, ignoreCap, staffInitiated } = input;
    console.log("[notifications] completed", {
        appointmentId: appointment.id,
        orderCount: orderNbrs.length,
    });
    await (0, cancelJobs_1.cancelPendingJobs)(prisma, appointment.id);
    if (!ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, appointment.id)))
        return;
    if ((0, eligibility_1.shouldSkipForQuietHours)(now))
        return;
    const activeToken = await (0, tokens_1.getActiveToken)(prisma, appointment.id);
    const token = activeToken ?? (await (0, tokens_1.createAppointmentToken)(prisma, appointment.id, appointment.endAt));
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.Completed, { link, orderNbrs, staffInitiated: Boolean(staffInitiated) }, undefined, Boolean(ignoreCap));
}
