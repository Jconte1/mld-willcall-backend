ALTER TABLE "PickupAppointment"
ADD COLUMN "noShowEmailAttemptedAt" TIMESTAMP(3),
ADD COLUMN "noShowEmailSentAt" TIMESTAMP(3),
ADD COLUMN "noShowSmsAttemptedAt" TIMESTAMP(3),
ADD COLUMN "noShowNotificationProcessedAt" TIMESTAMP(3);
