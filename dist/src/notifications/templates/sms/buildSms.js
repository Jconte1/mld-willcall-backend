"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSmsMessage = buildSmsMessage;
exports.applySmsCompliance = applySmsCompliance;
const client_1 = require("@prisma/client");
const format_1 = require("../../format");
const BRAND_PREFIX = "MLD Will Call:";
function buildSmsMessage(type, payload) {
    const when = (0, format_1.formatDenverDateTime)(payload.startAt);
    const orderLine = (0, format_1.formatOrderList)(payload.orderNbrs);
    const manageLink = payload.link;
    const locationLine = payload.locationAddress && payload.locationName
        ? `${payload.locationName} - ${payload.locationAddress}`
        : payload.locationAddress || payload.locationName;
    const locationText = locationLine ? ` Pickup location: ${locationLine}.` : "";
    switch (type) {
        case client_1.AppointmentNotificationType.ScheduledConfirm:
            return `${BRAND_PREFIX} Your pickup is scheduled for ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
        case client_1.AppointmentNotificationType.Reminder1Day:
            return `${BRAND_PREFIX} Reminder: your pickup is tomorrow at ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
        case client_1.AppointmentNotificationType.Reminder1Hour:
            return `${BRAND_PREFIX} Reminder: your pickup is in 1 hour at ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
        case client_1.AppointmentNotificationType.Rescheduled: {
            const oldWhen = payload.oldStartAt ? (0, format_1.formatDenverDateTime)(payload.oldStartAt) : "previous time";
            return `${BRAND_PREFIX} Your pickup was rescheduled from ${oldWhen} to ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
        }
        case client_1.AppointmentNotificationType.Cancelled: {
            const reason = payload.cancelReason ? ` Reason: ${payload.cancelReason}` : "";
            return `${BRAND_PREFIX} Your pickup on ${when} was cancelled.${reason} Manage: ${manageLink}`;
        }
        case client_1.AppointmentNotificationType.Completed:
            return `${BRAND_PREFIX} Your appointment is complete! Thank you for picking up with us. ${orderLine}. Manage: ${manageLink}`;
        case client_1.AppointmentNotificationType.OrderListChanged:
            return `${BRAND_PREFIX} Your pickup order list was updated. ${orderLine}. Manage: ${manageLink}`;
        case client_1.AppointmentNotificationType.ReadyForPickup:
            return `${BRAND_PREFIX} Your pickup is prepared. Our team has pulled your items for your scheduled pickup. ${orderLine}. Manage: ${manageLink}`;
        default:
            return `${BRAND_PREFIX} Pickup update: ${when}. ${orderLine}. Manage: ${manageLink}`;
    }
}
function applySmsCompliance(message, includeStopLine) {
    const lines = [message];
    if (includeStopLine) {
        lines.push("Reply STOP to opt out. Msg & data rates may apply.");
    }
    return lines.join(" ");
}
