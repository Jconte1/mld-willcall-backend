"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAppointmentCancelled = handleAppointmentCancelled;
const client_1 = require("@prisma/client");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const eligibility_1 = require("../rules/eligibility");
const cancelJobs_1 = require("./cancelJobs");
const sendImmediate_1 = require("./sendImmediate");
async function handleAppointmentCancelled(prisma, input) {
    const now = new Date();
    const { appointment, orderNbrs, cancelReason, shouldNotify, ignoreCap, staffInitiated } = input;
    console.log("[notifications] cancelled", {
        appointmentId: appointment.id,
        shouldNotify,
        hasReason: Boolean(cancelReason),
    });
    await (0, cancelJobs_1.cancelPendingJobs)(prisma, appointment.id);
    const token = await (0, tokens_1.rotateAppointmentToken)(prisma, appointment.id, appointment.endAt);
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    if (!shouldNotify)
        return;
    if (!ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, appointment.id)))
        return;
    if ((0, eligibility_1.shouldSkipForQuietHours)(now))
        return;
    await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.Cancelled, {
        link,
        orderNbrs,
        cancelReason: cancelReason ?? null,
        staffInitiated: Boolean(staffInitiated),
    }, undefined, Boolean(ignoreCap));
}
