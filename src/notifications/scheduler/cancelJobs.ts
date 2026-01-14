import { PrismaClient, NotificationJobStatus } from "@prisma/client";

export async function cancelPendingJobs(prisma: PrismaClient, appointmentId: string) {
  await prisma.appointmentNotificationJob.updateMany({
    where: {
      appointmentId,
      status: NotificationJobStatus.Pending,
    },
    data: { status: NotificationJobStatus.Cancelled },
  });
}
