"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPendingJobs = runPendingJobs;
const client_1 = require("@prisma/client");
const sendJob_1 = require("./sendJob");
const eligibility_1 = require("../rules/eligibility");
const quietHours_1 = require("../rules/quietHours");
const REMINDER_TYPES = new Set([
    client_1.AppointmentNotificationType.Reminder1Day,
    client_1.AppointmentNotificationType.Reminder1Hour,
]);
async function runPendingJobs(prisma) {
    const now = new Date();
    console.log("[notifications][worker] tick", { now: now.toISOString() });
    const jobs = await prisma.appointmentNotificationJob.findMany({
        where: {
            status: client_1.NotificationJobStatus.Pending,
            scheduledAt: { lte: now },
        },
        include: {
            appointment: {
                include: { orders: true },
            },
        },
        orderBy: { scheduledAt: "asc" },
        take: 50,
    });
    if (jobs.length === 0) {
        console.log("[notifications][worker] no pending jobs");
        return;
    }
    console.log("[notifications][worker] pending jobs", { count: jobs.length });
    for (const job of jobs) {
        console.log("[notifications][worker] processing", {
            id: job.id,
            type: job.type,
            scheduledAt: job.scheduledAt.toISOString(),
        });
        if ((0, eligibility_1.shouldSkipForQuietHours)(job.scheduledAt)) {
            const nextAt = (0, quietHours_1.nextAllowedTime)(new Date());
            console.log("[notifications][worker] deferred (quiet hours)", {
                id: job.id,
                nextAt: nextAt.toISOString(),
            });
            await prisma.appointmentNotificationJob.update({
                where: { id: job.id },
                data: {
                    status: client_1.NotificationJobStatus.Pending,
                    scheduledAt: nextAt,
                    lastAttemptAt: new Date(),
                },
            });
            continue;
        }
        const ignoreCap = Boolean(job.payloadSnapshot?.ignoreCap);
        if (!ignoreCap && (await (0, eligibility_1.hasReachedNotificationCap)(prisma, job.appointmentId))) {
            console.log("[notifications][worker] skipped (cap reached)", { id: job.id });
            await prisma.appointmentNotificationJob.update({
                where: { id: job.id },
                data: { status: client_1.NotificationJobStatus.Skipped, lastAttemptAt: new Date() },
            });
            continue;
        }
        const appointment = job.appointment;
        if (appointment.status === client_1.PickupAppointmentStatus.NoShow ||
            appointment.status === client_1.PickupAppointmentStatus.Completed ||
            appointment.status === client_1.PickupAppointmentStatus.Cancelled) {
            if (REMINDER_TYPES.has(job.type)) {
                console.log("[notifications][worker] cancelled (terminal status)", {
                    id: job.id,
                    status: appointment.status,
                });
                await prisma.appointmentNotificationJob.update({
                    where: { id: job.id },
                    data: { status: client_1.NotificationJobStatus.Cancelled, lastAttemptAt: new Date() },
                });
                continue;
            }
        }
        console.log("[notifications][worker] sending", { id: job.id, type: job.type });
        await (0, sendJob_1.sendJob)(prisma, job, appointment);
    }
}
