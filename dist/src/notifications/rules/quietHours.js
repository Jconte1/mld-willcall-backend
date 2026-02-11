"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isQuietHours = isQuietHours;
exports.nextAllowedTime = nextAllowedTime;
const DENVER_TZ = "America/Denver";
function isQuietHours(date) {
    const local = new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
    const hour = local.getHours();
    return hour >= 21 || hour < 7;
}
function nextAllowedTime(date) {
    if (!isQuietHours(date))
        return date;
    const local = new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
    const hour = local.getHours();
    const base = new Date(local);
    if (hour >= 21) {
        base.setDate(base.getDate() + 1);
    }
    base.setHours(7, 0, 0, 0);
    return new Date(base.toLocaleString("en-US", { timeZone: DENVER_TZ }));
}
