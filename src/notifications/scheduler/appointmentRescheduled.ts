import { PrismaClient, AppointmentNotificationType } from "@prisma/client";
import { buildAppointmentLink } from "../links/buildLink";
import { createAppointmentToken, getActiveToken } from "../links/tokens";
import { shouldSkipForQuietHours, hasReachedNotificationCap } from "../rules/eligibility";
import { computeReminderTimes } from "./computeReminderTimes";
import { cancelPendingJobs } from "./cancelJobs";
import { enqueueJob } from "../jobs/enqueueJob";
import { sendImmediate } from "./sendImmediate";
import { AppointmentWithContact } from "../types";

type RescheduleInput = {
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] };
  orderNbrs: string[];
  oldStartAt: Date;
  oldEndAt: Date;
  ignoreCap?: boolean;
  staffInitiated?: boolean;
};

export async function handleAppointmentRescheduled(
  prisma: PrismaClient,
  input: RescheduleInput
) {
  const now = new Date();
  const { appointment, orderNbrs, oldStartAt, oldEndAt, ignoreCap, staffInitiated } = input;

  console.log("[notifications] rescheduled", {
    appointmentId: appointment.id,
    oldStartAt: oldStartAt.toISOString(),
    newStartAt: appointment.startAt.toISOString(),
  });

  await cancelPendingJobs(prisma, appointment.id);

  const activeToken = await getActiveToken(prisma, appointment.id);
  const token = activeToken ?? (await createAppointmentToken(prisma, appointment.id, appointment.endAt));
  const link = buildAppointmentLink(appointment.id, token.token);

  const capReached = !ignoreCap && (await hasReachedNotificationCap(prisma, appointment.id));
  if (!shouldSkipForQuietHours(now) && !capReached) {
    await sendImmediate(
      prisma,
      appointment,
      AppointmentNotificationType.Rescheduled,
      {
        link,
        orderNbrs,
        oldStartAt: oldStartAt.toISOString(),
        oldEndAt: oldEndAt.toISOString(),
        staffInitiated: Boolean(staffInitiated),
      },
      undefined,
      Boolean(ignoreCap)
    );
  }

  const reminders = computeReminderTimes(appointment.startAt, now);
  if (reminders.oneHourAt) {
    await enqueueJob(prisma, {
      appointmentId: appointment.id,
      type: AppointmentNotificationType.Reminder1Hour,
      scheduledAt: reminders.oneHourAt,
      payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
    });
  } else if (reminders.sendOneHourImmediately && !shouldSkipForQuietHours(now)) {
    await sendImmediate(
      prisma,
      appointment,
      AppointmentNotificationType.Reminder1Hour,
      { link, orderNbrs },
      undefined,
      Boolean(ignoreCap)
    );
  }

  if (reminders.oneDayAt) {
    await enqueueJob(prisma, {
      appointmentId: appointment.id,
      type: AppointmentNotificationType.Reminder1Day,
      scheduledAt: reminders.oneDayAt,
      payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
    });
  }
}
