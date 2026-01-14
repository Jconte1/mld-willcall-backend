export function buildAppointmentLink(appointmentId: string, token: string) {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return `${base}/appointments/${appointmentId}?token=${encodeURIComponent(token)}`;
}

function getBackendBaseUrl() {
  const explicit = process.env.BACKEND_URL || process.env.BACKEND_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, "");
  return "";
}

export function buildUnsubscribeLink(appointmentId: string, token: string) {
  const base = getBackendBaseUrl();
  if (!base) return "";
  return `${base}/api/public/appointments/${appointmentId}/unsubscribe?token=${encodeURIComponent(token)}`;
}
