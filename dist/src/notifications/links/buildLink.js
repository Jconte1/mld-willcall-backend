"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAppointmentLink = buildAppointmentLink;
exports.buildOrderReadyLink = buildOrderReadyLink;
exports.buildUnsubscribeLink = buildUnsubscribeLink;
exports.buildAppointmentSmsLink = buildAppointmentSmsLink;
exports.buildOrderReadySmsLink = buildOrderReadySmsLink;
const appUrls_1 = require("../../lib/appUrls");
function buildAppointmentLink(appointmentId, token) {
    const base = (0, appUrls_1.getFrontendBaseUrl)();
    return `${base}/appointments/${appointmentId}?token=${encodeURIComponent(token)}`;
}
function buildOrderReadyLink(orderNbr, token) {
    const base = (0, appUrls_1.getFrontendBaseUrl)();
    return `${base}/orders/ready/${encodeURIComponent(orderNbr)}?token=${encodeURIComponent(token)}`;
}
function buildUnsubscribeLink(appointmentId, token) {
    const base = (0, appUrls_1.getBackendBaseUrl)();
    if (!base)
        return "";
    return `${base}/api/public/appointments/${appointmentId}/unsubscribe?token=${encodeURIComponent(token)}`;
}
function buildAppointmentSmsLink(token) {
    const base = (0, appUrls_1.getBackendBaseUrl)();
    if (!base)
        return "";
    return `${base}/api/public/appointments/short/${encodeURIComponent(token)}`;
}
function buildOrderReadySmsLink(token) {
    const base = (0, appUrls_1.getBackendBaseUrl)();
    if (!base)
        return "";
    return `${base}/api/public/order-ready/short/${encodeURIComponent(token)}`;
}
