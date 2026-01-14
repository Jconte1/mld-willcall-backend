"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelPendingJobs = cancelPendingJobs;
const client_1 = require("@prisma/client");
async function cancelPendingJobs(prisma, appointmentId) {
    await prisma.appointmentNotificationJob.updateMany({
        where: {
            appointmentId,
            status: client_1.NotificationJobStatus.Pending,
        },
        data: { status: client_1.NotificationJobStatus.Cancelled },
    });
}
