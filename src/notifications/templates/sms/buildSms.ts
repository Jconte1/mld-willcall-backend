import { AppointmentNotificationType } from "@prisma/client";
import { formatDenverDateTime, formatOrderList } from "../../format";
import { NotificationPayload } from "../../types";

const BRAND_PREFIX = "MLD Will Call:";

export function buildSmsMessage(type: AppointmentNotificationType, payload: NotificationPayload) {
  const when = formatDenverDateTime(payload.startAt);
  const orderLine = formatOrderList(payload.orderNbrs);
  const manageLink = payload.link;
  const locationLine =
    payload.locationAddress && payload.locationName
      ? `${payload.locationName} - ${payload.locationAddress}`
      : payload.locationAddress || payload.locationName;
  const locationText = locationLine ? ` Pickup location: ${locationLine}.` : "";

  switch (type) {
    case AppointmentNotificationType.ScheduledConfirm:
      return `${BRAND_PREFIX} Your pickup is scheduled for ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
    case AppointmentNotificationType.Reminder1Day:
      return `${BRAND_PREFIX} Reminder: your pickup is tomorrow at ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
    case AppointmentNotificationType.Reminder1Hour:
      return `${BRAND_PREFIX} Reminder: your pickup is in 1 hour at ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
    case AppointmentNotificationType.Rescheduled: {
      const oldWhen = payload.oldStartAt ? formatDenverDateTime(payload.oldStartAt) : "previous time";
      return `${BRAND_PREFIX} Your pickup was rescheduled from ${oldWhen} to ${when}.${locationText} ${orderLine}. Manage: ${manageLink}`;
    }
    case AppointmentNotificationType.Cancelled: {
      const reason = payload.cancelReason ? ` Reason: ${payload.cancelReason}` : "";
      return `${BRAND_PREFIX} Your pickup on ${when} was cancelled.${reason} Manage: ${manageLink}`;
    }
    case AppointmentNotificationType.Completed:
      return `${BRAND_PREFIX} Your pickup for ${when} is marked complete. ${orderLine}. Manage: ${manageLink}`;
    case AppointmentNotificationType.OrderListChanged:
      return `${BRAND_PREFIX} Your pickup order list was updated. ${orderLine}. Manage: ${manageLink}`;
    case AppointmentNotificationType.ReadyForPickup:
      return `${BRAND_PREFIX} Your pickup is prepared. Our team has pulled your items for your scheduled pickup. ${orderLine}. Manage: ${manageLink}`;
    default:
      return `${BRAND_PREFIX} Pickup update: ${when}. ${orderLine}. Manage: ${manageLink}`;
  }
}

export function applySmsCompliance(message: string, includeStopLine: boolean) {
  const lines = [message];
  if (includeStopLine) {
    lines.push("Reply STOP to opt out. Msg & data rates may apply.");
  }
  return lines.join(" ");
}
