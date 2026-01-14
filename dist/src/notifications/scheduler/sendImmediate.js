"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendImmediate = sendImmediate;
const client_1 = require("@prisma/client");
const enqueueJob_1 = require("../jobs/enqueueJob");
const sendJob_1 = require("../jobs/sendJob");
async function sendImmediate(prisma, appointment, type, payloadSnapshot, channel = client_1.NotificationChannel.Both, ignoreCap = false) {
    console.log("[notifications] sendImmediate", { appointmentId: appointment.id, type, channel });
    const scheduledAt = new Date();
    const job = await (0, enqueueJob_1.enqueueJob)(prisma, {
        appointmentId: appointment.id,
        type,
        scheduledAt,
        channel,
        payloadSnapshot: { ...payloadSnapshot, ignoreCap },
    });
    await (0, sendJob_1.sendJob)(prisma, job, appointment);
}
