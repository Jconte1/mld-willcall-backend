"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldSkipForQuietHours = shouldSkipForQuietHours;
exports.hasReachedNotificationCap = hasReachedNotificationCap;
const client_1 = require("@prisma/client");
const quietHours_1 = require("./quietHours");
function shouldSkipForQuietHours(date) {
    return (0, quietHours_1.isQuietHours)(date);
}
async function hasReachedNotificationCap(prisma, appointmentId, cap = Number(process.env.NOTIFICATIONS_CAP || 10)) {
    const sentCount = await prisma.appointmentNotificationJob.count({
        where: { appointmentId, status: client_1.NotificationJobStatus.Sent },
    });
    return sentCount >= cap;
}
