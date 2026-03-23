"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDenverDateOnly = parseDenverDateOnly;
exports.makeDenverDateTime = makeDenverDateTime;
const DENVER_TZ = "America/Denver";
function normalizeOffset(raw) {
    const value = raw.replace("GMT", "").trim();
    const withColon = value.match(/^([+-]\d{1,2})(?::?(\d{2}))?$/);
    if (withColon) {
        const signHour = withColon[1];
        const minutes = withColon[2] ?? "00";
        const sign = signHour.startsWith("-") ? "-" : "+";
        const hour = signHour.replace(/[+-]/, "").padStart(2, "0");
        return `${sign}${hour}:${minutes}`;
    }
    return "-07:00";
}
function getDenverOffsetForDate(dateStr) {
    // Probe noon UTC and ask Intl for Denver offset on that local date.
    // Appointments are scheduled during business hours, so noon offset is valid.
    const probe = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        timeZoneName: "shortOffset",
    }).formatToParts(probe);
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-07:00";
    return normalizeOffset(raw);
}
function parseDenverDateOnly(dateStr) {
    const offset = getDenverOffsetForDate(dateStr);
    return new Date(`${dateStr}T12:00:00${offset}`);
}
function makeDenverDateTime(dateStr, time) {
    const offset = getDenverOffsetForDate(dateStr);
    return new Date(`${dateStr}T${time}:00${offset}`);
}
