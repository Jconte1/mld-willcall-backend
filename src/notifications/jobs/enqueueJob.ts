import { PrismaClient, AppointmentNotificationType, NotificationChannel } from "@prisma/client";

type EnqueueInput = {
  appointmentId: string;
  type: AppointmentNotificationType;
  scheduledAt: Date;
  channel?: NotificationChannel;
  payloadSnapshot?: Record<string, any>;
};

export async function enqueueJob(prisma: PrismaClient, input: EnqueueInput) {
  const idempotencyKey = `${input.appointmentId}:${input.type}:${input.scheduledAt.toISOString()}`;

  return prisma.appointmentNotificationJob.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      appointmentId: input.appointmentId,
      type: input.type,
      channel: input.channel ?? NotificationChannel.Both,
      scheduledAt: input.scheduledAt,
      idempotencyKey,
      payloadSnapshot: input.payloadSnapshot ?? undefined,
    },
  });
}
