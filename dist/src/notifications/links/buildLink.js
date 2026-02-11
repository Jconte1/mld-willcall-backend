"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAppointmentLink = buildAppointmentLink;
exports.buildOrderReadyLink = buildOrderReadyLink;
exports.buildUnsubscribeLink = buildUnsubscribeLink;
exports.buildAppointmentSmsLink = buildAppointmentSmsLink;
exports.buildOrderReadySmsLink = buildOrderReadySmsLink;
function buildAppointmentLink(appointmentId, token) {
    const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    return `${base}/appointments/${appointmentId}?token=${encodeURIComponent(token)}`;
}
function buildOrderReadyLink(orderNbr, token) {
    const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    return `${base}/orders/ready/${encodeURIComponent(orderNbr)}?token=${encodeURIComponent(token)}`;
}
function getBackendBaseUrl() {
    const explicit = process.env.BACKEND_URL || process.env.BACKEND_API_URL;
    if (explicit)
        return explicit.replace(/\/+$/, "");
    if (process.env.VERCEL_URL)
        return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, "");
    return "";
}
function buildUnsubscribeLink(appointmentId, token) {
    const base = getBackendBaseUrl();
    if (!base)
        return "";
    return `${base}/api/public/appointments/${appointmentId}/unsubscribe?token=${encodeURIComponent(token)}`;
}
function buildAppointmentSmsLink(token) {
    const base = getBackendBaseUrl();
    if (!base)
        return "";
    return `${base}/api/public/appointments/short/${encodeURIComponent(token)}`;
}
function buildOrderReadySmsLink(token) {
    const base = getBackendBaseUrl();
    if (!base)
        return "";
    return `${base}/api/public/order-ready/short/${encodeURIComponent(token)}`;
}
