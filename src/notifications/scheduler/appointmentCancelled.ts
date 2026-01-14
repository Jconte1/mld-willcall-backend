import { PrismaClient, AppointmentNotificationType } from "@prisma/client";
import { buildAppointmentLink } from "../links/buildLink";
import { rotateAppointmentToken } from "../links/tokens";
import { shouldSkipForQuietHours, hasReachedNotificationCap } from "../rules/eligibility";
import { cancelPendingJobs } from "./cancelJobs";
import { sendImmediate } from "./sendImmediate";
import { AppointmentWithContact } from "../types";

type CancelInput = {
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] };
  orderNbrs: string[];
  cancelReason?: string | null;
  shouldNotify: boolean;
  ignoreCap?: boolean;
  staffInitiated?: boolean;
};

export async function handleAppointmentCancelled(
  prisma: PrismaClient,
  input: CancelInput
) {
  const now = new Date();
  const { appointment, orderNbrs, cancelReason, shouldNotify, ignoreCap, staffInitiated } = input;

  console.log("[notifications] cancelled", {
    appointmentId: appointment.id,
    shouldNotify,
    hasReason: Boolean(cancelReason),
  });

  await cancelPendingJobs(prisma, appointment.id);

  const token = await rotateAppointmentToken(prisma, appointment.id, appointment.endAt);
  const link = buildAppointmentLink(appointment.id, token.token);

  if (!shouldNotify) return;
  if (!ignoreCap && (await hasReachedNotificationCap(prisma, appointment.id))) return;
  if (shouldSkipForQuietHours(now)) return;

  await sendImmediate(
    prisma,
    appointment,
    AppointmentNotificationType.Cancelled,
    {
      link,
      orderNbrs,
      cancelReason: cancelReason ?? null,
      staffInitiated: Boolean(staffInitiated),
    },
    undefined,
    Boolean(ignoreCap)
  );
}
