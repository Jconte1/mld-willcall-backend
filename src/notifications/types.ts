import {
  AppointmentNotificationType,
  NotificationChannel,
  NotificationJobStatus,
  PickupAppointment,
} from "@prisma/client";

export type NotificationType = AppointmentNotificationType;
export type NotificationChannelType = NotificationChannel;
export type NotificationStatusType = NotificationJobStatus;

export type AppointmentWithContact = Pick<
  PickupAppointment,
  | "id"
  | "startAt"
  | "endAt"
  | "locationId"
  | "status"
  | "customerFirstName"
  | "customerLastName"
  | "customerEmail"
  | "customerPhone"
  | "smsOptIn"
  | "smsOptInAt"
  | "smsOptInSource"
  | "smsOptInPhone"
  | "smsOptOutAt"
  | "smsOptOutReason"
  | "smsFirstSentAt"
  | "emailOptIn"
  | "emailOptInAt"
  | "emailOptInSource"
  | "emailOptInEmail"
>;

export type NotificationPayload = {
  appointmentId: string;
  locationId: string;
  locationName?: string;
  locationAddress?: string;
  locationInstructions?: string;
  startAt: Date;
  endAt: Date;
  orderNbrs?: string[];
  link: string;
  smsLink?: string;
  unsubscribeLink?: string;
  customerName?: string;
  oldStartAt?: Date;
  oldEndAt?: Date;
  cancelReason?: string | null;
  ignoreCap?: boolean;
  staffInitiated?: boolean;
};

export type NotificationContext = {
  now?: Date;
  notifyCustomer?: boolean;
  cancelReason?: string | null;
  orderNbrs?: string[];
  oldStartAt?: Date;
  oldEndAt?: Date;
  oldLocationId?: string | null;
};
