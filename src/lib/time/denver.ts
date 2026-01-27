const DENVER_TZ = "America/Denver";

export function startOfDayDenver(d: Date = new Date()) {
  const local = new Date(d.toLocaleString("en-US", { timeZone: DENVER_TZ }));
  local.setHours(0, 0, 0, 0);
  return local;
}

export function oneYearAgoDenver(d: Date = new Date()) {
  const s = startOfDayDenver(d);
  s.setFullYear(s.getFullYear() - 1);
  return s;
}

export function toDenverDateTimeOffsetLiteral(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  }).formatToParts(d);

  const rawTz = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-00:00";
  let offset = "-00:00";
  const m1 = rawTz.match(/([+-])(\d{2}):?(\d{2})?/);
  if (m1) {
    const sign = m1[1];
    const hh = m1[2];
    const mm = m1[3] || "00";
    offset = `${sign}${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
  } else {
    const m2 = rawTz.match(/([+-])(\d{1,2})$/);
    if (m2) {
      const sign = m2[1];
      const hh = m2[2].padStart(2, "0");
      offset = `${sign}${hh}:00`;
    }
  }
  return `datetimeoffset'${y}-${m}-${day}T00:00:00${offset}'`;
}

export function toDenverDateTimeOffsetLiteralAt(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  }).formatToParts(date);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const yyyy = get("year");
  const MM = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  const offsetRaw = (get("timeZoneName") || "").replace("GMT", "") || "+00:00";

  return `datetimeoffset'${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${offsetRaw}'`;
}

export function denver3amWindowStartLiteral(now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  }).formatToParts(now);

  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const yyyy = get("year");
  const MM = get("month");
  const dd = get("day");
  const hh = Number(get("hour") || 0);
  const offsetRaw = (get("timeZoneName") || "").replace("GMT", "") || "+00:00";

  if (hh >= 3) {
    return `datetimeoffset'${yyyy}-${MM}-${dd}T03:00:00${offsetRaw}'`;
  }

  const today3 = new Date(`${yyyy}-${MM}-${dd}T03:00:00${offsetRaw}`);
  const yParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(today3.getTime() - 24 * 60 * 60 * 1000));
  const yY = yParts.find((p) => p.type === "year")?.value;
  const yM = yParts.find((p) => p.type === "month")?.value;
  const yD = yParts.find((p) => p.type === "day")?.value;
  return `datetimeoffset'${yY}-${yM}-${yD}T03:00:00${offsetRaw}'`;
}

export function toDenver(date: Date = new Date()) {
  return new Date(date.toLocaleString("en-US", { timeZone: DENVER_TZ }));
}

export function atDenver(
  date: Date = new Date(),
  hour = 9,
  minute = 0,
  second = 0,
  ms = 0
) {
  const denver = toDenver(date);
  denver.setHours(hour, minute, second, ms);
  const y = denver.getFullYear();
  const m = String(denver.getMonth() + 1).padStart(2, "0");
  const d = String(denver.getDate()).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}-07:00`);
}

export function addDaysDenver(date: Date = new Date(), days = 1) {
  const denver = toDenver(date);
  denver.setDate(denver.getDate() + days);
  const y = denver.getFullYear();
  const m = String(denver.getMonth() + 1).padStart(2, "0");
  const d = String(denver.getDate()).padStart(2, "0");
  const hh = String(denver.getHours()).padStart(2, "0");
  const mm = String(denver.getMinutes()).padStart(2, "0");
  const ss = String(denver.getSeconds()).padStart(2, "0");
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
}
