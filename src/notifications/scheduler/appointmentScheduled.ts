import { PrismaClient, AppointmentNotificationType } from "@prisma/client";
import { buildAppointmentLink } from "../links/buildLink";
import { createAppointmentToken } from "../links/tokens";
import { shouldSkipForQuietHours, hasReachedNotificationCap } from "../rules/eligibility";
import { computeReminderTimes } from "./computeReminderTimes";
import { enqueueJob } from "../jobs/enqueueJob";
import { sendImmediate } from "./sendImmediate";
import { AppointmentWithContact } from "../types";

type ScheduleInput = {
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] };
  orderNbrs: string[];
  staffCreated?: boolean;
  ignoreCap?: boolean;
};

export async function handleAppointmentScheduled(
  prisma: PrismaClient,
  input: ScheduleInput
) {
  const now = new Date();
  const { appointment, orderNbrs, staffCreated, ignoreCap } = input;

  console.log("[notifications] scheduled", {
    appointmentId: appointment.id,
    staffCreated,
    orderCount: orderNbrs.length,
  });

  if (!ignoreCap && (await hasReachedNotificationCap(prisma, appointment.id))) return;
  if (shouldSkipForQuietHours(now)) return;

  const token = await createAppointmentToken(prisma, appointment.id, appointment.endAt);
  const link = buildAppointmentLink(appointment.id, token.token);

  await sendImmediate(
    prisma,
    appointment,
    AppointmentNotificationType.ScheduledConfirm,
    {
      link,
      orderNbrs,
      staffInitiated: Boolean(staffCreated),
    },
    undefined,
    Boolean(ignoreCap)
  );

  const reminders = computeReminderTimes(appointment.startAt, now);
  if (reminders.oneHourAt) {
    await enqueueJob(prisma, {
      appointmentId: appointment.id,
      type: AppointmentNotificationType.Reminder1Hour,
      scheduledAt: reminders.oneHourAt,
      payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
    });
  } else if (reminders.sendOneHourImmediately) {
    await sendImmediate(
      prisma,
      appointment,
      AppointmentNotificationType.Reminder1Hour,
      { link, orderNbrs },
      undefined,
      Boolean(ignoreCap)
    );
  }

  if (!staffCreated && reminders.oneDayAt) {
    await enqueueJob(prisma, {
      appointmentId: appointment.id,
      type: AppointmentNotificationType.Reminder1Day,
      scheduledAt: reminders.oneDayAt,
      payloadSnapshot: { link, orderNbrs, ignoreCap: Boolean(ignoreCap) },
    });
  }
}
