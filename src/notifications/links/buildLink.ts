export function buildAppointmentLink(appointmentId: string, token: string) {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return `${base}/appointments/${appointmentId}?token=${encodeURIComponent(token)}`;
}
