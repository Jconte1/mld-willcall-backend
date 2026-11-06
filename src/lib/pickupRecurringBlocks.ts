import { normalizeLocationId } from "./locationIds";
import { denverDateKey } from "./time/denver";
import { makeDenverDateTime } from "./time/denverLocalDateTime";

const EFFECTIVE_DATE = "2026-11-09";
const START_TIME = "10:00";
const END_TIME = "10:45";
const REASON = "Warehouse team meeting";

function calendarDate(date: string) {
  return new Date(`${date}T00:00:00Z`);
}

export function getRecurringPickupBlock(locationId: string, date: string) {
  if (normalizeLocationId(locationId) !== "slc-hq" || date < EFFECTIVE_DATE) return null;
  const day = calendarDate(date);
  if (Number.isNaN(day.getTime()) || day.getUTCDay() !== 1) return null;
  return { date, startTime: START_TIME, endTime: END_TIME, reason: REASON };
}

export function isRecurringPickupSlotBlocked(
  locationId: string, date: string, startTime: string, endTime: string
) {
  const block = getRecurringPickupBlock(locationId, date);
  return Boolean(block && startTime < block.endTime && endTime > block.startTime);
}

export function findRecurringPickupBlock(locationId: string, startAt: Date, endAt: Date) {
  if (normalizeLocationId(locationId) !== "slc-hq" ||
      !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) return null;

  // Find the first candidate Monday in calendar days, then convert its bounds to Denver time.
  const firstDate = denverDateKey(startAt);
  const monday = calendarDate(firstDate < EFFECTIVE_DATE ? EFFECTIVE_DATE : firstDate);
  monday.setUTCDate(monday.getUTCDate() + (8 - monday.getUTCDay()) % 7);
  let date = monday.toISOString().slice(0, 10);
  if (makeDenverDateTime(date, END_TIME) <= startAt) {
    monday.setUTCDate(monday.getUTCDate() + 7);
    date = monday.toISOString().slice(0, 10);
  }
  if (startAt < makeDenverDateTime(date, END_TIME) && endAt > makeDenverDateTime(date, START_TIME)) {
    return getRecurringPickupBlock(locationId, date);
  }
  return null;
}
