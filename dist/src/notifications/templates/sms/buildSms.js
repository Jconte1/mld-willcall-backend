"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSmsMessage = buildSmsMessage;
const client_1 = require("@prisma/client");
const format_1 = require("../../format");
function buildSmsMessage(type, payload) {
    const when = (0, format_1.formatDenverDateTime)(payload.startAt);
    const orderLine = (0, format_1.formatOrderList)(payload.orderNbrs);
    switch (type) {
        case client_1.AppointmentNotificationType.ScheduledConfirm:
            return `Your pickup is scheduled for ${when}. ${orderLine}. Manage: ${payload.link}`;
        case client_1.AppointmentNotificationType.Reminder1Day:
            return `Reminder: your pickup is tomorrow at ${when}. ${orderLine}. Manage: ${payload.link}`;
        case client_1.AppointmentNotificationType.Reminder1Hour:
            return `Reminder: your pickup is in 1 hour at ${when}. ${orderLine}. Manage: ${payload.link}`;
        case client_1.AppointmentNotificationType.Rescheduled: {
            const oldWhen = payload.oldStartAt ? (0, format_1.formatDenverDateTime)(payload.oldStartAt) : "previous time";
            return `Your pickup was rescheduled from ${oldWhen} to ${when}. ${orderLine}. Manage: ${payload.link}`;
        }
        case client_1.AppointmentNotificationType.Cancelled: {
            const reason = payload.cancelReason ? ` Reason: ${payload.cancelReason}` : "";
            return `Your pickup on ${when} was cancelled.${reason} Manage: ${payload.link}`;
        }
        case client_1.AppointmentNotificationType.Completed:
            return `Your pickup for ${when} is marked complete. ${orderLine}. Manage: ${payload.link}`;
        case client_1.AppointmentNotificationType.OrderListChanged:
            return `Your pickup order list was updated. ${orderLine}. Manage: ${payload.link}`;
        default:
            return `Pickup update: ${when}. ${orderLine}. Manage: ${payload.link}`;
    }
}
