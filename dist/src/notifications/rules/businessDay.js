"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previousBusinessDayAtNine = previousBusinessDayAtNine;
const DENVER_TZ = "America/Denver";
function toDenver(date) {
    return new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
}
function isWeekend(date) {
    const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        weekday: "short",
    }).format(date);
    return weekday === "Sat" || weekday === "Sun";
}
function previousBusinessDayAtNine(startAt) {
    const denver = toDenver(startAt);
    denver.setDate(denver.getDate() - 1);
    while (isWeekend(denver))
        denver.setDate(denver.getDate() - 1);
    denver.setHours(9, 0, 0, 0);
    return denver;
}
