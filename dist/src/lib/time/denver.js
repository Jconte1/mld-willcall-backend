"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.oneYearAgoDenver = oneYearAgoDenver;
exports.toDenverDateTimeOffsetLiteral = toDenverDateTimeOffsetLiteral;
const DENVER_TZ = "America/Denver";
function toDenverParts(date) {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });
    const parts = dtf.formatToParts(date);
    const map = {};
    for (const p of parts)
        map[p.type] = p.value;
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second),
    };
}
function pad2(n) {
    return String(n).padStart(2, "0");
}
function denverOffsetMinutes(date) {
    const parts = toDenverParts(date);
    const utcWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((utcWall - date.getTime()) / 60000);
}
function oneYearAgoDenver(now) {
    const parts = toDenverParts(now);
    const utcWall = Date.UTC(parts.year - 1, parts.month - 1, parts.day, 0, 0, 0);
    return new Date(utcWall);
}
function toDenverDateTimeOffsetLiteral(date) {
    const parts = toDenverParts(date);
    const local = [
        `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
        "T",
        `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`,
    ].join("");
    const offsetMinutes = denverOffsetMinutes(date);
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const offH = pad2(Math.floor(abs / 60));
    const offM = pad2(abs % 60);
    return `datetimeoffset'${local}${sign}${offH}:${offM}'`;
}
