import { AppointmentNotificationType } from "@prisma/client";
import { formatDenverDateTime, formatOrderList } from "../../format";
import { NotificationPayload } from "../../types";

export function buildSmsMessage(type: AppointmentNotificationType, payload: NotificationPayload) {
  const when = formatDenverDateTime(payload.startAt);
  const orderLine = formatOrderList(payload.orderNbrs);
  const locationLine =
    payload.locationAddress && payload.locationName
      ? `${payload.locationName} - ${payload.locationAddress}`
      : payload.locationAddress || payload.locationName;
  const locationText = locationLine ? ` Pickup location: ${locationLine}.` : "";

  switch (type) {
    case AppointmentNotificationType.ScheduledConfirm:
      return `Your pickup is scheduled for ${when}.${locationText} ${orderLine}. Manage: ${payload.link}`;
    case AppointmentNotificationType.Reminder1Day:
      return `Reminder: your pickup is tomorrow at ${when}.${locationText} ${orderLine}. Manage: ${payload.link}`;
    case AppointmentNotificationType.Reminder1Hour:
      return `Reminder: your pickup is in 1 hour at ${when}.${locationText} ${orderLine}. Manage: ${payload.link}`;
    case AppointmentNotificationType.Rescheduled: {
      const oldWhen = payload.oldStartAt ? formatDenverDateTime(payload.oldStartAt) : "previous time";
      return `Your pickup was rescheduled from ${oldWhen} to ${when}.${locationText} ${orderLine}. Manage: ${payload.link}`;
    }
    case AppointmentNotificationType.Cancelled: {
      const reason = payload.cancelReason ? ` Reason: ${payload.cancelReason}` : "";
      return `Your pickup on ${when} was cancelled.${reason} Manage: ${payload.link}`;
    }
    case AppointmentNotificationType.Completed:
      return `Your pickup for ${when} is marked complete. ${orderLine}. Manage: ${payload.link}`;
    case AppointmentNotificationType.OrderListChanged:
      return `Your pickup order list was updated. ${orderLine}. Manage: ${payload.link}`;
    case AppointmentNotificationType.ReadyForPickup:
      return `Your pickup is prepared. Our team has pulled your items for your scheduled pickup. ${orderLine}. Manage: ${payload.link}`;
    default:
      return `Pickup update: ${when}. ${orderLine}. Manage: ${payload.link}`;
  }
}
