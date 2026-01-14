import { PrismaClient, AppointmentNotificationType } from "@prisma/client";
import { buildAppointmentLink } from "../links/buildLink";
import { getActiveToken, createAppointmentToken } from "../links/tokens";
import { shouldSkipForQuietHours, hasReachedNotificationCap } from "../rules/eligibility";
import { sendImmediate } from "./sendImmediate";
import { AppointmentWithContact } from "../types";

type OrderChangeInput = {
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] };
  orderNbrs: string[];
  ignoreCap?: boolean;
  staffInitiated?: boolean;
};

export async function handleAppointmentOrderListChanged(
  prisma: PrismaClient,
  input: OrderChangeInput
) {
  const now = new Date();
  const { appointment, orderNbrs, ignoreCap, staffInitiated } = input;

  console.log("[notifications] order list changed", {
    appointmentId: appointment.id,
    orderCount: orderNbrs.length,
  });

  if (!ignoreCap && (await hasReachedNotificationCap(prisma, appointment.id))) return;
  if (shouldSkipForQuietHours(now)) return;

  const activeToken = await getActiveToken(prisma, appointment.id);
  const token = activeToken ?? (await createAppointmentToken(prisma, appointment.id, appointment.endAt));
  const link = buildAppointmentLink(appointment.id, token.token);

  await sendImmediate(
    prisma,
    appointment,
    AppointmentNotificationType.OrderListChanged,
    { link, orderNbrs, staffInitiated: Boolean(staffInitiated) },
    undefined,
    Boolean(ignoreCap)
  );
}
