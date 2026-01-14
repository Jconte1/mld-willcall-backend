import { PrismaClient, NotificationJobStatus } from "@prisma/client";
import { isQuietHours } from "./quietHours";

export function shouldSkipForQuietHours(date: Date) {
  return isQuietHours(date);
}

export async function hasReachedNotificationCap(
  prisma: PrismaClient,
  appointmentId: string,
  cap = Number(process.env.NOTIFICATIONS_CAP || 10)
) {
  const sentCount = await prisma.appointmentNotificationJob.count({
    where: { appointmentId, status: NotificationJobStatus.Sent },
  });
  return sentCount >= cap;
}
