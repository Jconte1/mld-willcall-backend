import { getBackendBaseUrl, getFrontendBaseUrl } from "../../lib/appUrls";

export function buildAppointmentLink(appointmentId: string, token: string) {
  const base = getFrontendBaseUrl();
  return `${base}/appointments/${appointmentId}?token=${encodeURIComponent(token)}`;
}

export function buildOrderReadyLink(orderNbr: string, token: string) {
  const base = getFrontendBaseUrl();
  return `${base}/orders/ready/${encodeURIComponent(orderNbr)}?token=${encodeURIComponent(token)}`;
}

export function buildUnsubscribeLink(appointmentId: string, token: string) {
  const base = getBackendBaseUrl();
  if (!base) return "";
  return `${base}/api/public/appointments/${appointmentId}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function buildAppointmentSmsLink(token: string) {
  const base = getBackendBaseUrl();
  if (!base) return "";
  return `${base}/api/public/appointments/short/${encodeURIComponent(token)}`;
}

export function buildOrderReadySmsLink(token: string) {
  const base = getBackendBaseUrl();
  if (!base) return "";
  return `${base}/api/public/order-ready/short/${encodeURIComponent(token)}`;
}
