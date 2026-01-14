"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDenverDateTime = formatDenverDateTime;
exports.formatOrderList = formatOrderList;
const DENVER_TZ = "America/Denver";
function formatDenverDateTime(value) {
    const date = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(value);
    const time = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        hour: "numeric",
        minute: "2-digit",
    }).format(value);
    return `${date} ${time}`;
}
function formatOrderList(orderNbrs = []) {
    if (!orderNbrs.length)
        return "Orders: (none)";
    return `Orders: ${orderNbrs.join(", ")}`;
}
