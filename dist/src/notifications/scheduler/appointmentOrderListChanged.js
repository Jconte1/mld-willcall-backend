"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAppointmentOrderListChanged = handleAppointmentOrderListChanged;
const client_1 = require("@prisma/client");
const buildLink_1 = require("../links/buildLink");
const tokens_1 = require("../links/tokens");
const eligibility_1 = require("../rules/eligibility");
const sendImmediate_1 = require("./sendImmediate");
async function handleAppointmentOrderListChanged(prisma, input) {
    const now = new Date();
    const { appointment, orderNbrs, ignoreCap, staffInitiated } = input;
    console.log("[notifications] order list changed", {
        appointmentId: appointment.id,
        orderCount: orderNbrs.length,
    });
    if (!ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, appointment.id)))
        return;
    if ((0, eligibility_1.shouldSkipForQuietHours)(now))
        return;
    const activeToken = await (0, tokens_1.getActiveToken)(prisma, appointment.id);
    const token = activeToken ?? (await (0, tokens_1.createAppointmentToken)(prisma, appointment.id, appointment.endAt));
    const link = (0, buildLink_1.buildAppointmentLink)(appointment.id, token.token);
    await (0, sendImmediate_1.sendImmediate)(prisma, appointment, client_1.AppointmentNotificationType.OrderListChanged, { link, orderNbrs, staffInitiated: Boolean(staffInitiated) }, undefined, Boolean(ignoreCap));
}
