"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAppointmentReady = handleAppointmentReady;
const client_1 = require("@prisma/client");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const eligibility_1 = require("../rules/eligibility");
const quietHours_1 = require("../rules/quietHours");
const enqueueJob_1 = require("../jobs/enqueueJob");
const READY_WINDOW_MS = 24 * 60 * 60 * 1000;
async function handleAppointmentReady(prisma, input) {
    // TODO: Ready-for-pickup notifications still honor NOTIFICATIONS_TEST_EMAIL; switch to live recipients before production.
    const now = new Date();
    const { appointment, orderNbrs, ignoreCap, staffInitiated } = input;
    if (!ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, appointment.id)))
        return;
    const activeToken = await (0, tokens_1.getActiveToken)(prisma, appointment.id);
    const token = activeToken ?? (await (0, tokens_1.createAppointmentToken)(prisma, appointment.id, appointment.endAt));
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    const readyAt = new Date(appointment.startAt.getTime() - READY_WINDOW_MS);
    let scheduledAt = readyAt.getTime() <= now.getTime() ? now : readyAt;
    scheduledAt = (0, quietHours_1.nextAllowedTime)(scheduledAt);
    await (0, enqueueJob_1.enqueueJob)(prisma, {
        appointmentId: appointment.id,
        type: client_1.AppointmentNotificationType.ReadyForPickup,
        scheduledAt,
        payloadSnapshot: {
            link,
            orderNbrs,
            ignoreCap: Boolean(ignoreCap),
            staffInitiated: Boolean(staffInitiated),
        },
    });
}
