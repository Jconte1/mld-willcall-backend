const DENVER_TZ = "America/Denver";

export function formatDenverDateTime(value: Date) {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);

  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(value);

  return `${date} ${time}`;
}

export function formatOrderList(orderNbrs: string[] = []) {
  if (!orderNbrs.length) return "Orders: (none)";
  return `Orders: ${orderNbrs.join(", ")}`;
}
