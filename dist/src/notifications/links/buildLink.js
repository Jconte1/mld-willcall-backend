"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAppointmentLink = buildAppointmentLink;
function buildAppointmentLink(appointmentId, token) {
    const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    return `${base}/appointments/${appointmentId}?token=${encodeURIComponent(token)}`;
}
