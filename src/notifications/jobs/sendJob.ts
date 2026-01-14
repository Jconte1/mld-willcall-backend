import {
  AppointmentNotificationJob,
  AppointmentNotificationType,
  NotificationChannel,
  NotificationJobStatus,
  PrismaClient,
} from "@prisma/client";
import { buildSmsMessage } from "../templates/sms/buildSms";
import { buildEmailMessage } from "../templates/email/buildEmail";
import { sendSms } from "../providers/sms/sendSms";
import { sendEmail } from "../providers/email/sendEmail";
import { AppointmentWithContact, NotificationPayload } from "../types";

function buildPayload(
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  job: AppointmentNotificationJob,
  link: string
): NotificationPayload {
  const snapshot = (job.payloadSnapshot || {}) as Record<string, any>;
  const orderNbrs = snapshot.orderNbrs || appointment.orders?.map((o) => o.orderNbr) || [];

  return {
    appointmentId: appointment.id,
    locationId: appointment.locationId,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    orderNbrs,
    link,
    oldStartAt: snapshot.oldStartAt ? new Date(snapshot.oldStartAt) : undefined,
    oldEndAt: snapshot.oldEndAt ? new Date(snapshot.oldEndAt) : undefined,
    cancelReason: snapshot.cancelReason ?? null,
    staffInitiated: Boolean(snapshot.staffInitiated),
  };
}

export async function sendJob(
  prisma: PrismaClient,
  job: AppointmentNotificationJob,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] }
) {
  const link = (job.payloadSnapshot as any)?.link as string | undefined;
  if (!link) {
    throw new Error(`Missing secure link for notification job ${job.id}`);
  }

  const payload = buildPayload(appointment, job, link);

  try {
    console.log("[notifications] sendJob", {
      id: job.id,
      type: job.type,
      channel: job.channel,
      appointmentId: appointment.id,
    });
    if (job.channel === NotificationChannel.SMS || job.channel === NotificationChannel.Both) {
      if (appointment.smsOptIn && (appointment.smsOptInPhone || appointment.customerPhone)) {
        const sms = buildSmsMessage(job.type as AppointmentNotificationType, payload);
        const smsTo = appointment.smsOptInPhone || appointment.customerPhone;
        await sendSms(smsTo as string, sms);
      }
    }

    if (job.channel === NotificationChannel.Email || job.channel === NotificationChannel.Both) {
      if (appointment.emailOptIn && (appointment.emailOptInEmail || appointment.customerEmail)) {
        const email = buildEmailMessage(job.type as AppointmentNotificationType, payload);
        const emailTo = appointment.emailOptInEmail || appointment.customerEmail;
        await sendEmail(emailTo as string, email.subject, email.body);
      }
    }

    await prisma.appointmentNotificationJob.update({
      where: { id: job.id },
      data: {
        status: NotificationJobStatus.Sent,
        sentAt: new Date(),
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[notifications] sendJob failed", err);
    await prisma.appointmentNotificationJob.update({
      where: { id: job.id },
      data: {
        status: NotificationJobStatus.Failed,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    throw err;
  }
}
