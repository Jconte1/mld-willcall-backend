import {
  AppointmentNotificationType,
  NotificationJobStatus,
  PickupAppointmentStatus,
  PrismaClient,
} from "@prisma/client";
import { sendJob } from "./sendJob";
import { shouldSkipForQuietHours, hasReachedNotificationCap } from "../rules/eligibility";

const REMINDER_TYPES = new Set<AppointmentNotificationType>([
  AppointmentNotificationType.Reminder1Day,
  AppointmentNotificationType.Reminder1Hour,
]);

export async function runPendingJobs(prisma: PrismaClient) {
  const now = new Date();
  console.log("[notifications][worker] tick", { now: now.toISOString() });
  const jobs = await prisma.appointmentNotificationJob.findMany({
    where: {
      status: NotificationJobStatus.Pending,
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
    if (shouldSkipForQuietHours(job.scheduledAt)) {
      console.log("[notifications][worker] skipped (quiet hours)", { id: job.id });
      await prisma.appointmentNotificationJob.update({
        where: { id: job.id },
        data: { status: NotificationJobStatus.Skipped, lastAttemptAt: new Date() },
      });
      continue;
    }

    const ignoreCap = Boolean((job.payloadSnapshot as any)?.ignoreCap);
    if (!ignoreCap && (await hasReachedNotificationCap(prisma, job.appointmentId))) {
      console.log("[notifications][worker] skipped (cap reached)", { id: job.id });
      await prisma.appointmentNotificationJob.update({
        where: { id: job.id },
        data: { status: NotificationJobStatus.Skipped, lastAttemptAt: new Date() },
      });
      continue;
    }

    const appointment = job.appointment;
    if (
      appointment.status === PickupAppointmentStatus.NoShow ||
      appointment.status === PickupAppointmentStatus.Completed ||
      appointment.status === PickupAppointmentStatus.Cancelled
    ) {
      if (REMINDER_TYPES.has(job.type as AppointmentNotificationType)) {
        console.log("[notifications][worker] cancelled (terminal status)", {
          id: job.id,
          status: appointment.status,
        });
        await prisma.appointmentNotificationJob.update({
          where: { id: job.id },
          data: { status: NotificationJobStatus.Cancelled, lastAttemptAt: new Date() },
        });
        continue;
      }
    }

    console.log("[notifications][worker] sending", { id: job.id, type: job.type });
    await sendJob(prisma, job, appointment);
  }
}
