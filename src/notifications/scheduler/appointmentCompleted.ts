import { PrismaClient, AppointmentNotificationType } from "@prisma/client";
import { buildAppointmentLink } from "../links/buildLink";
import { getActiveToken, createAppointmentToken } from "../links/tokens";
import { shouldSkipForQuietHours, hasReachedNotificationCap } from "../rules/eligibility";
import { cancelPendingJobs } from "./cancelJobs";
import { sendImmediate } from "./sendImmediate";
import { AppointmentWithContact } from "../types";

type CompleteInput = {
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] };
  orderNbrs: string[];
  ignoreCap?: boolean;
  staffInitiated?: boolean;
};

export async function handleAppointmentCompleted(
  prisma: PrismaClient,
  input: CompleteInput
) {
  // TODO: Completed notifications still honor NOTIFICATIONS_TEST_EMAIL; switch to live recipients before production.
  const now = new Date();
  const { appointment, orderNbrs, ignoreCap, staffInitiated } = input;

  console.log("[notifications] completed", {
    appointmentId: appointment.id,
    orderCount: orderNbrs.length,
  });

  await cancelPendingJobs(prisma, appointment.id);
  if (!ignoreCap && (await hasReachedNotificationCap(prisma, appointment.id))) return;
  if (shouldSkipForQuietHours(now)) return;

  const activeToken = await getActiveToken(prisma, appointment.id);
  const token = activeToken ?? (await createAppointmentToken(prisma, appointment.id, appointment.endAt));
  const link = buildAppointmentLink(appointment.id, token.token);

  await sendImmediate(
    prisma,
    appointment,
    AppointmentNotificationType.Completed,
    { link, orderNbrs, staffInitiated: Boolean(staffInitiated) },
    undefined,
    Boolean(ignoreCap)
  );
}
