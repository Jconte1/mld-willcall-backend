const DENVER_TZ = "America/Denver";

function toDenver(date: Date) {
  return new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
}

function isWeekend(date: Date) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    weekday: "short",
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

export function previousBusinessDayAtNine(startAt: Date) {
  const denver = toDenver(startAt);
  denver.setDate(denver.getDate() - 1);
  while (isWeekend(denver)) denver.setDate(denver.getDate() - 1);
  denver.setHours(9, 0, 0, 0);
  return denver;
}
