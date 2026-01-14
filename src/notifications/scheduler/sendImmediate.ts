import {
  AppointmentNotificationType,
  NotificationChannel,
  PrismaClient,
} from "@prisma/client";
import { enqueueJob } from "../jobs/enqueueJob";
import { sendJob } from "../jobs/sendJob";
import { AppointmentWithContact } from "../types";

export async function sendImmediate(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  type: AppointmentNotificationType,
  payloadSnapshot: Record<string, any>,
  channel: NotificationChannel = NotificationChannel.Both,
  ignoreCap = false
) {
  console.log("[notifications] sendImmediate", { appointmentId: appointment.id, type, channel });
  const scheduledAt = new Date();
  const job = await enqueueJob(prisma, {
    appointmentId: appointment.id,
    type,
    scheduledAt,
    channel,
    payloadSnapshot: { ...payloadSnapshot, ignoreCap },
  });
  await sendJob(prisma, job, appointment);
}
