"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueJob = enqueueJob;
const client_1 = require("@prisma/client");
async function enqueueJob(prisma, input) {
    const idempotencyKey = `${input.appointmentId}:${input.type}:${input.scheduledAt.toISOString()}`;
    return prisma.appointmentNotificationJob.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
            appointmentId: input.appointmentId,
            type: input.type,
            channel: input.channel ?? client_1.NotificationChannel.Both,
            scheduledAt: input.scheduledAt,
            idempotencyKey,
            payloadSnapshot: input.payloadSnapshot ?? undefined,
        },
    });
}
