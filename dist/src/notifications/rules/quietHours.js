"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isQuietHours = isQuietHours;
const DENVER_TZ = "America/Denver";
function isQuietHours(date) {
    const local = new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
    const hour = local.getHours();
    return hour >= 21 || hour < 7;
}
