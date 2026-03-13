import {
  AppointmentNotificationJob,
  AppointmentNotificationType,
  NotificationChannel,
  NotificationJobStatus,
  PrismaClient,
} from "@prisma/client";
import { applySmsCompliance, buildSmsMessage } from "../templates/sms/buildSms";
import { buildEmailMessage } from "../templates/email/buildEmail";
import { sendSms } from "../providers/sms/sendSms";
import { sendEmail } from "../providers/email/sendEmail";
import { AppointmentWithContact, NotificationPayload } from "../types";
import { buildUnsubscribeLink } from "../links/buildLink";
import { getPickupLocation } from "../../lib/pickupLocations";
import { resolveOrderReadyJobDisplay } from "../orderReady/orderDisplay";

function normalizeOrderNbrs(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((v) => String(v || "").trim()).filter(Boolean)));
}

async function buildPayload(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  job: AppointmentNotificationJob,
  link: string
): Promise<NotificationPayload> {
  const snapshot = (job.payloadSnapshot || {}) as Record<string, any>;
  const fallbackOrderNbrs = appointment.orders?.map((o) => o.orderNbr) ?? [];
  const normalizedOrderNbrs = normalizeOrderNbrs(snapshot.orderNbrs ?? fallbackOrderNbrs);
  const summaries = normalizedOrderNbrs.length
    ? await prisma.erpOrderSummary.findMany({
        where: {
          orderNbr: { in: normalizedOrderNbrs },
          isActive: true,
        },
        select: {
          orderNbr: true,
          locationId: true,
          jobName: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      })
    : [];
  const summaryByOrderNbr = new Map<string, (typeof summaries)[number]>();
  for (const summary of summaries) {
    const key = summary.orderNbr.trim().toUpperCase();
    if (!summaryByOrderNbr.has(key)) summaryByOrderNbr.set(key, summary);
  }

  const orderDisplays = normalizedOrderNbrs.map((orderNbr) => {
    const summary = summaryByOrderNbr.get(orderNbr.trim().toUpperCase());
    const jobDisplay = resolveOrderReadyJobDisplay({
      locationId: summary?.locationId,
      jobName: summary?.jobName,
    });
    return {
      orderNbr,
      jobDisplay,
    };
  });

  const unsubscribeLink = snapshot.unsubscribeLink || buildUnsubscribeFromLink(link, appointment.id);
  const location = getPickupLocation(appointment.locationId);
  const locationName = location?.name ?? appointment.locationId;

  return {
    appointmentId: appointment.id,
    locationId: appointment.locationId,
    locationName,
    locationAddress: location?.address,
    locationInstructions: location?.instructions,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    orderNbrs: normalizedOrderNbrs,
    orderDisplays,
    link,
    unsubscribeLink: unsubscribeLink || undefined,
    oldStartAt: snapshot.oldStartAt ? new Date(snapshot.oldStartAt) : undefined,
    oldEndAt: snapshot.oldEndAt ? new Date(snapshot.oldEndAt) : undefined,
    cancelReason: snapshot.cancelReason ?? null,
    staffInitiated: Boolean(snapshot.staffInitiated),
  };
}

function buildUnsubscribeFromLink(link: string, appointmentId: string) {
  try {
    const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "") || "http://localhost";
    const url = new URL(link, base);
    const token = url.searchParams.get("token");
    if (!token) return "";
    return buildUnsubscribeLink(appointmentId, token);
  } catch {
    return "";
  }
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

  const payload = await buildPayload(prisma, appointment, job, link);

  try {
    console.log("[notifications] sendJob", {
      id: job.id,
      type: job.type,
      channel: job.channel,
      appointmentId: appointment.id,
    });
    if (job.channel === NotificationChannel.SMS || job.channel === NotificationChannel.Both) {
      if (
        appointment.smsOptIn &&
        !appointment.smsOptOutAt &&
        (appointment.smsOptInPhone || appointment.customerPhone)
      ) {
        const sms = buildSmsMessage(job.type as AppointmentNotificationType, payload);
        const includeStopLine = !appointment.smsFirstSentAt;
        const smsBody = applySmsCompliance(sms, includeStopLine);
        const smsTo = appointment.smsOptInPhone || appointment.customerPhone;
        await sendSms(smsTo as string, smsBody, { allowTestOverride: false });
        if (!appointment.smsFirstSentAt) {
          await prisma.pickupAppointment.update({
            where: { id: appointment.id },
            data: { smsFirstSentAt: new Date() },
          });
        }
      }
    }

    if (job.channel === NotificationChannel.Email || job.channel === NotificationChannel.Both) {
      if (appointment.emailOptIn && (appointment.emailOptInEmail || appointment.customerEmail)) {
        const email = buildEmailMessage(job.type as AppointmentNotificationType, payload);
        const emailTo = appointment.emailOptInEmail || appointment.customerEmail;
        await sendEmail(emailTo as string, email.subject, email.body, { allowTestOverride: false });
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
