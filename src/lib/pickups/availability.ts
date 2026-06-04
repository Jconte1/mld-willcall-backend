import { PickupAppointmentStatus } from "@prisma/client";
import { equivalentPickupLocationIds } from "../locationIds";
import { isHolidayClosure } from "../pickupClosures";
import { getPickupHours } from "../pickupHours";
import { prisma } from "../prisma";
import { makeDenverDateTime, parseDenverDateOnly } from "../time/denverLocalDateTime";

const DENVER_TZ = "America/Denver";
const SLOT_MINUTES = 15;

const BLOCKING_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
];

type GetPickupAvailabilityInput = {
  locationId: string;
  from: string;
  to: string;
  now?: Date;
  includeStaffMetadata?: boolean;
};

function getMinAdvanceMinutes(locationId: string) {
  if (locationId === "boise-willcall") return 2 * 60;
  if (locationId === "jackson-willcall") return 0;
  return 4 * 60;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function parseDateOnly(dateStr: string) {
  return parseDenverDateOnly(dateStr);
}

function nextCalendarDateStr(dateStr: string) {
  return formatDateInDenver(addMinutes(parseDateOnly(dateStr), 24 * 60));
}

function formatDateInDenver(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function formatTimeInDenver(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

function isWeekend(dateStr: string) {
  const date = parseDateOnly(dateStr);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    weekday: "short",
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

function isClosedDate(dateStr: string, locationId: string) {
  return isWeekend(dateStr) || isHolidayClosure(dateStr, locationId);
}

function nextBusinessDateStr(dateStr: string, locationId: string) {
  let cursor = parseDateOnly(dateStr);
  while (true) {
    cursor = addMinutes(cursor, 24 * 60);
    const next = formatDateInDenver(cursor);
    if (!isClosedDate(next, locationId)) return next;
  }
}

function ceilToSlot(minutes: number) {
  return Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}

function timeToMinutes(time: string) {
  const [hh, mm] = time.split(":").map((part) => Number(part));
  return hh * 60 + mm;
}

function minutesToTime(totalMinutes: number) {
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function getMinAllowedSlot(now: Date, locationId: string) {
  let cursorDateStr = formatDateInDenver(now);
  let cursorMinutes = timeToMinutes(formatTimeInDenver(now));
  let remainingAdvance = getMinAdvanceMinutes(locationId);

  while (true) {
    const { openHour, closeHour } = getPickupHours(locationId);
    const openMinutes = openHour * 60;
    const closeMinutes = closeHour * 60;

    if (isClosedDate(cursorDateStr, locationId)) {
      cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
      cursorMinutes = getPickupHours(locationId).openHour * 60;
      continue;
    }

    if (cursorMinutes < openMinutes) cursorMinutes = openMinutes;
    if (cursorMinutes >= closeMinutes) {
      cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
      cursorMinutes = getPickupHours(locationId).openHour * 60;
      continue;
    }

    const availableToday = closeMinutes - cursorMinutes;
    if (remainingAdvance <= availableToday) {
      let minMinutes = ceilToSlot(cursorMinutes + remainingAdvance);
      const lastStartMinutes = closeMinutes - SLOT_MINUTES;
      if (minMinutes > lastStartMinutes) {
        cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
        const { openHour: nextOpenHour } = getPickupHours(locationId);
        minMinutes = nextOpenHour * 60;
      }
      return { dateStr: cursorDateStr, minutes: minMinutes };
    }

    remainingAdvance -= availableToday;
    cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
    cursorMinutes = getPickupHours(locationId).openHour * 60;
  }
}

function getSlotStarts(startAt: Date, endAt: Date) {
  const starts: Array<{ date: string; startTime: string }> = [];
  for (let cursor = new Date(startAt); cursor < endAt; cursor = addMinutes(cursor, SLOT_MINUTES)) {
    starts.push({
      date: formatDateInDenver(cursor),
      startTime: formatTimeInDenver(cursor),
    });
  }
  return starts;
}

function buildSlotsForDate(
  locationId: string,
  dateStr: string,
  manualBlocks: Set<string>,
  appointmentBlocks: Set<string>,
  minStartMinutes: number | null,
  includeStaffMetadata: boolean
) {
  if (isClosedDate(dateStr, locationId)) return [];

  const slots = [];
  const { openHour, closeHour } = getPickupHours(locationId);
  const startMinutes = openHour * 60;
  const lastStartMinutes = closeHour * 60 - SLOT_MINUTES;

  for (let minutes = startMinutes; minutes <= lastStartMinutes; minutes += SLOT_MINUTES) {
    const startTime = minutesToTime(minutes);
    const endTime = minutesToTime(minutes + SLOT_MINUTES);
    const manuallyBlocked = manualBlocks.has(startTime);
    const occupied = appointmentBlocks.has(startTime);
    const tooEarly = minStartMinutes != null && minutes < minStartMinutes;
    const available = !tooEarly && !manuallyBlocked && !occupied;

    const slot = {
      id: `slot-${dateStr.replace(/-/g, "")}-${startTime.replace(":", "")}`,
      startTime,
      endTime,
      available,
      capacityRemaining: available ? 1 : 0,
    };

    slots.push(
      includeStaffMetadata
        ? {
            ...slot,
            manuallyBlocked,
            occupied,
            tooEarly,
          }
        : slot
    );
  }

  return slots;
}

export async function getPickupAvailability(input: GetPickupAvailabilityInput) {
  const { locationId, from, to, includeStaffMetadata = false } = input;
  const now = input.now ?? new Date();
  const minAllowed = getMinAllowedSlot(now, locationId);
  const rangeStart = makeDenverDateTime(from, "00:00");
  const rangeEnd = makeDenverDateTime(nextCalendarDateStr(to), "00:00");
  const cursorStart = parseDateOnly(from);
  const cursorEnd = addMinutes(parseDateOnly(to), 24 * 60);
  const locationIds = equivalentPickupLocationIds(locationId);

  const appointments = await prisma.pickupAppointment.findMany({
    where: {
      locationId: { in: locationIds },
      status: { in: BLOCKING_STATUSES },
      startAt: { lt: rangeEnd },
      endAt: { gt: rangeStart },
    },
    select: { startAt: true, endAt: true },
  });

  const manualBlocks = await prisma.pickupManualBlock.findMany({
    where: {
      locationId: { in: locationIds },
      date: { gte: from, lte: to },
    },
    select: { date: true, startTime: true },
  });

  const manualBlocksByDate = new Map<string, Set<string>>();
  for (const block of manualBlocks) {
    const slots = manualBlocksByDate.get(block.date) ?? new Set<string>();
    slots.add(block.startTime);
    manualBlocksByDate.set(block.date, slots);
  }

  const appointmentBlocksByDate = new Map<string, Set<string>>();
  for (const appointment of appointments) {
    for (const slot of getSlotStarts(appointment.startAt, appointment.endAt)) {
      const slots = appointmentBlocksByDate.get(slot.date) ?? new Set<string>();
      slots.add(slot.startTime);
      appointmentBlocksByDate.set(slot.date, slots);
    }
  }

  const availability = [];
  for (let cursor = new Date(cursorStart); cursor < cursorEnd; cursor = addMinutes(cursor, 24 * 60)) {
    const dateStr = formatDateInDenver(cursor);
    let minStartMinutes: number | null = null;
    if (dateStr < minAllowed.dateStr) {
      minStartMinutes = Infinity;
    } else if (dateStr === minAllowed.dateStr) {
      minStartMinutes = minAllowed.minutes;
    }

    availability.push({
      date: dateStr,
      isBlackedOut: isClosedDate(dateStr, locationId),
      slots: buildSlotsForDate(
        locationId,
        dateStr,
        manualBlocksByDate.get(dateStr) ?? new Set<string>(),
        appointmentBlocksByDate.get(dateStr) ?? new Set<string>(),
        minStartMinutes,
        includeStaffMetadata
      ),
    });
  }

  return availability;
}
