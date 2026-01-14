"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOfDayDenver = startOfDayDenver;
exports.oneYearAgoDenver = oneYearAgoDenver;
exports.toDenverDateTimeOffsetLiteral = toDenverDateTimeOffsetLiteral;
exports.toDenver = toDenver;
exports.atDenver = atDenver;
exports.addDaysDenver = addDaysDenver;
const DENVER_TZ = "America/Denver";
function startOfDayDenver(d = new Date()) {
    const local = new Date(d.toLocaleString("en-US", { timeZone: DENVER_TZ }));
    local.setHours(0, 0, 0, 0);
    return local;
}
function oneYearAgoDenver(d = new Date()) {
    const s = startOfDayDenver(d);
    s.setFullYear(s.getFullYear() - 1);
    return s;
}
function toDenverDateTimeOffsetLiteral(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
    }).formatToParts(d);
    const rawTz = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-00:00";
    let offset = "-00:00";
    const m1 = rawTz.match(/([+-])(\d{2}):?(\d{2})?/);
    if (m1) {
        const sign = m1[1];
        const hh = m1[2];
        const mm = m1[3] || "00";
        offset = `${sign}${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
    }
    else {
        const m2 = rawTz.match(/([+-])(\d{1,2})$/);
        if (m2) {
            const sign = m2[1];
            const hh = m2[2].padStart(2, "0");
            offset = `${sign}${hh}:00`;
        }
    }
    return `datetimeoffset'${y}-${m}-${day}T00:00:00${offset}'`;
}
function toDenver(date = new Date()) {
    return new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
}
function atDenver(date = new Date(), hour = 9, minute = 0, second = 0, ms = 0) {
    const denver = toDenver(date);
    denver.setHours(hour, minute, second, ms);
    const y = denver.getFullYear();
    const m = String(denver.getMonth() + 1).padStart(2, "0");
    const d = String(denver.getDate()).padStart(2, "0");
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    const ss = String(second).padStart(2, "0");
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}-07:00`);
}
function addDaysDenver(date = new Date(), days = 1) {
    const denver = toDenver(date);
    denver.setDate(denver.getDate() + days);
    const y = denver.getFullYear();
    const m = String(denver.getMonth() + 1).padStart(2, "0");
    const d = String(denver.getDate()).padStart(2, "0");
    const hh = String(denver.getHours()).padStart(2, "0");
    const mm = String(denver.getMinutes()).padStart(2, "0");
    const ss = String(denver.getSeconds()).padStart(2, "0");
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
}
