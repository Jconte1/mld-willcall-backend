import { Router } from "express";
import { PickupAppointmentStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  notifyAppointmentRescheduled,
  notifyCustomerCancelled,
  cancelAppointmentNotifications,
} from "../notifications";
import { buildAppointmentLink } from "../notifications/links/buildLink";
import { getActiveToken, createAppointmentToken } from "../notifications/links/tokens";
import { toNumber } from "../lib/orders/orderHelpers";
import { makeDenverDateTime, parseDenverDateOnly } from "../lib/time/denverLocalDateTime";
import { getPickupHours } from "../lib/pickupHours";
import { isHolidayClosure } from "../lib/pickupClosures";

export const publicAppointmentsRouter = Router();

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_MINUTES = 15;

function getMinAdvanceMinutes(locationId: string) {
  if (locationId === "boise-willcall") return 2 * 60;
  if (locationId === "jackson-willcall") return 0;
  return 4 * 60;
}

const tokenSchema = z.object({
  token: z.string().min(1),
});

const slotSchema = z.object({
  startTime: z.string().regex(TIME_RE),
  endTime: z.string().regex(TIME_RE),
});

const rescheduleSchema = z.object({
  action: z.literal("reschedule"),
  selectedDate: z.string().regex(DATE_RE),
  selectedSlots: z.array(slotSchema).min(1).max(2),
});

const cancelSchema = z.object({
  action: z.literal("cancel"),
});

function timeToMinutes(time: string) {
  const [hh, mm] = time.split(":").map((part) => Number(part));
  return hh * 60 + mm;
}

function isWeekend(dateStr: string) {
  const date = parseDateOnly(dateStr);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

function isClosedDate(dateStr: string, locationId: string) {
  return isWeekend(dateStr) || isHolidayClosure(dateStr, locationId);
}

function formatDateInDenver(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function getDenverParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    dateStr,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function parseDateOnly(dateStr: string) {
  return parseDenverDateOnly(dateStr);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
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

function ensureWithinBusinessHours(locationId: string, dateStr: string, slots: { startTime: string }[]) {
  if (isClosedDate(dateStr, locationId)) return false;
  const { openHour, closeHour } = getPickupHours(locationId);
  const startMinutes = openHour * 60;
  const lastStartMinutes = (closeHour * 60) - SLOT_MINUTES;
  return slots.every((slot) => {
    const minutes = timeToMinutes(slot.startTime);
    return minutes >= startMinutes && minutes <= lastStartMinutes;
  });
}

function areSlotsContiguous(slots: { startTime: string }[]) {
  if (slots.length <= 1) return true;
  const ordered = [...slots].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  return timeToMinutes(ordered[1].startTime) - timeToMinutes(ordered[0].startTime) === SLOT_MINUTES;
}

function makeDateTime(dateStr: string, time: string) {
  return makeDenverDateTime(dateStr, time);
}

function getMinAllowedSlot(now: Date, locationId: string) {
  const timeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [hour, minute] = timeStr.split(":").map((part) => Number(part));
  let cursorDateStr = formatDateInDenver(now);
  let cursorMinutes = hour * 60 + minute;
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

async function validateToken(appointmentId: string, token: string) {
  return prisma.appointmentAccessToken.findFirst({
    where: {
      appointmentId,
      token,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
}

async function getLatestLink(appointmentId: string) {
  const token = await getActiveToken(prisma, appointmentId);
  if (!token) return null;
  return buildAppointmentLink(appointmentId, token.token);
}

/**
 * GET /api/public/appointments/short/:token
 */
publicAppointmentsRouter.get("/short/:token", async (req, res) => {
  const tokenValue = req.params.token;
  const frontend = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/+$/, "");

  const token = await prisma.appointmentAccessToken.findFirst({
    where: {
      token: tokenValue,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!token) {
    return res.redirect(`${frontend}/appointments/invalid`);
  }

  const longLink = buildAppointmentLink(token.appointmentId, tokenValue);
  return res.redirect(longLink);
});

/**
 * GET /api/public/appointments/:id?token=...
 */
publicAppointmentsRouter.get("/:id", async (req, res) => {
  const parsed = tokenSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid token" });
  }

  const token = await validateToken(req.params.id, parsed.data.token);
  if (!token) return res.status(403).json({ message: "Invalid or expired token" });

  const appointment = await prisma.pickupAppointment.findUnique({
    where: { id: req.params.id },
    include: { orders: true },
  });
  if (!appointment) return res.status(404).json({ message: "Not found" });

  const orderNbrs = appointment.orders.map((order) => order.orderNbr);
  const selectedLines = await prisma.pickupAppointmentLine.findMany({
    where: { appointmentId: appointment.id },
    select: {
      orderNbr: true,
      inventoryId: true,
      lineDescription: true,
      qtySelected: true,
    },
    orderBy: [{ orderNbr: "asc" }, { inventoryId: "asc" }],
  });

  const orderLines = orderNbrs.map((orderNbr) => ({
    orderNbr,
    items: selectedLines
      .filter((line) => line.orderNbr === orderNbr)
      .map((line) => ({
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        qty: toNumber(line.qtySelected),
      })),
  }));

  return res.json({ appointment, orderLines });
});

/**
 * GET /api/public/appointments/:id/unsubscribe?token=...
 */
publicAppointmentsRouter.get("/:id/unsubscribe", async (req, res) => {
  const frontend = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/+$/, "");
  return res.redirect(`${frontend}/`);
});

/**
 * PATCH /api/public/appointments/:id?token=...
 * Body: { action: "cancel" } or { action: "reschedule", selectedDate, selectedSlots }
 */
publicAppointmentsRouter.patch("/:id", async (req, res) => {
  const parsedToken = tokenSchema.safeParse(req.query);
  if (!parsedToken.success) {
    return res.status(400).json({ message: "Invalid token" });
  }

  const token = await validateToken(req.params.id, parsedToken.data.token);
  if (!token) return res.status(403).json({ message: "Invalid or expired token" });

  const action = req.body?.action;
  const appointment = await prisma.pickupAppointment.findUnique({
    where: { id: req.params.id },
    include: { orders: true },
  });
  if (!appointment) return res.status(404).json({ message: "Not found" });

  if (action === "cancel") {
    if (appointment.status === PickupAppointmentStatus.NoShow) {
      return res.status(409).json({
        message: "Appointment already marked no-show; please reschedule.",
      });
    }
    if (appointment.status === PickupAppointmentStatus.Cancelled) {
      return res.json({ appointment });
    }
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

    const updated = await prisma.pickupAppointment.update({
      where: { id: appointment.id },
      data: { status: PickupAppointmentStatus.Cancelled },
    });

    await cancelAppointmentNotifications(prisma, updated.id);
    await notifyCustomerCancelled(
      prisma,
      updated,
      appointment.orders.map((o: { orderNbr: string }) => o.orderNbr)
    );

    const nextLink = await getLatestLink(updated.id);
    return res.json({ appointment: updated, nextLink });
  }

  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const disallowedStatuses: PickupAppointmentStatus[] = [PickupAppointmentStatus.Completed];
  if (disallowedStatuses.includes(appointment.status as PickupAppointmentStatus)) {
    return res.status(409).json({ message: "Appointment cannot be rescheduled." });
  }

  const requiredSlots = appointment.orders.length > 6 ? 2 : 1;
  if (parsed.data.selectedSlots.length !== requiredSlots) {
    return res.status(400).json({ message: "Selected slots do not match appointment size." });
  }

  if (!ensureWithinBusinessHours(appointment.locationId, parsed.data.selectedDate, parsed.data.selectedSlots)) {
    return res.status(400).json({ message: "Selected time is outside business hours." });
  }
  const minAllowed = getMinAllowedSlot(new Date(), appointment.locationId);
  const now = new Date();
  console.log("[public-appointments][min-advance]", {
    now: now.toISOString(),
    denverDate: formatDateInDenver(now),
    denverTime: new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
    selectedDate: parsed.data.selectedDate,
    selectedStart: parsed.data.selectedSlots[0]?.startTime,
    minAllowedDate: minAllowed.dateStr,
    minAllowedMinutes: minAllowed.minutes,
  });
  const selectedStartMinutes = timeToMinutes(parsed.data.selectedSlots[0].startTime);
  if (parsed.data.selectedDate < minAllowed.dateStr) {
    return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
  }
  if (parsed.data.selectedDate === minAllowed.dateStr && selectedStartMinutes < minAllowed.minutes) {
    return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
  }

  if (!areSlotsContiguous(parsed.data.selectedSlots)) {
    return res.status(400).json({ message: "Selected slots must be consecutive." });
  }

  const orderedSlots = [...parsed.data.selectedSlots].sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
  );
  const startAt = makeDateTime(parsed.data.selectedDate, orderedSlots[0].startTime);
  const endAt = makeDateTime(parsed.data.selectedDate, orderedSlots[orderedSlots.length - 1].endTime);

  const manualBlock = await prisma.pickupManualBlock.findFirst({
    where: {
      locationId: appointment.locationId,
      date: parsed.data.selectedDate,
      startTime: { in: parsed.data.selectedSlots.map((slot) => slot.startTime) },
    },
    select: { id: true },
  });
  if (manualBlock) {
    return res.status(409).json({ message: "Time slot no longer available." });
  }

  const conflict = await prisma.pickupAppointment.findFirst({
    where: {
      id: { not: appointment.id },
      locationId: appointment.locationId,
      status: { in: [PickupAppointmentStatus.Scheduled, PickupAppointmentStatus.Confirmed] },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
    select: { id: true },
  });
  if (conflict) {
    return res.status(409).json({ message: "Time slot no longer available." });
  }

  const updated = await prisma.pickupAppointment.update({
    where: { id: appointment.id },
    data: {
      startAt,
      endAt,
      status: PickupAppointmentStatus.Scheduled,
    },
  });

  await notifyAppointmentRescheduled(
    prisma,
    updated,
    appointment.orders.map((o: { orderNbr: string }) => o.orderNbr),
    appointment.startAt,
    appointment.endAt,
    true
  );

  const activeToken = await getActiveToken(prisma, updated.id);
  const tokenRow = activeToken ?? (await createAppointmentToken(prisma, updated.id, updated.endAt));
  const link = buildAppointmentLink(updated.id, tokenRow.token);
  return res.json({ appointment: updated, link });
});
