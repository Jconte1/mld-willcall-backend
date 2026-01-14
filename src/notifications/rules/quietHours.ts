const DENVER_TZ = "America/Denver";

export function isQuietHours(date: Date) {
  const local = new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
  const hour = local.getHours();
  return hour >= 21 || hour < 7;
}
