import { PrismaClient, AppointmentNotificationType } from "@prisma/client";
import { buildAppointmentLink } from "../links/buildLink";
import { createAppointmentToken, getActiveToken } from "../links/tokens";
import { hasReachedNotificationCap } from "../rules/eligibility";
import { enqueueJob } from "../jobs/enqueueJob";
import { AppointmentWithContact } from "../types";

type ReadyInput = {
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] };
  orderNbrs: string[];
  ignoreCap?: boolean;
  staffInitiated?: boolean;
};

const READY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function handleAppointmentReady(
  prisma: PrismaClient,
  input: ReadyInput
) {
  // TODO: Ready-for-pickup notifications still honor NOTIFICATIONS_TEST_EMAIL; switch to live recipients before production.
  const now = new Date();
  const { appointment, orderNbrs, ignoreCap, staffInitiated } = input;

  if (!ignoreCap && (await hasReachedNotificationCap(prisma, appointment.id))) return;

  const activeToken = await getActiveToken(prisma, appointment.id);
  const token = activeToken ?? (await createAppointmentToken(prisma, appointment.id, appointment.endAt));
  const link = buildAppointmentLink(appointment.id, token.token);

  const readyAt = new Date(appointment.startAt.getTime() - READY_WINDOW_MS);
  const scheduledAt = readyAt.getTime() <= now.getTime() ? now : readyAt;

  await enqueueJob(prisma, {
    appointmentId: appointment.id,
    type: AppointmentNotificationType.ReadyForPickup,
    scheduledAt,
    payloadSnapshot: {
      link,
      orderNbrs,
      ignoreCap: Boolean(ignoreCap),
      staffInitiated: Boolean(staffInitiated),
    },
  });
}
