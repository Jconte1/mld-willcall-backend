import { Router } from "express";
import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import { z } from "zod";
import {
  notifyAppointmentRescheduled,
  notifyCustomerCancelled,
} from "../notifications";
import { buildAppointmentLink } from "../notifications/links/buildLink";
import { getActiveToken, createAppointmentToken } from "../notifications/links/tokens";

const prisma = new PrismaClient();
export const publicAppointmentsRouter = Router();

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_MINUTES = 15;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 17;

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
  const date = new Date(`${dateStr}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

function ensureWithinBusinessHours(dateStr: string, slots: { startTime: string }[]) {
  if (isWeekend(dateStr)) return false;
  const startMinutes = OPEN_HOUR * 60;
  const lastStartMinutes = (CLOSE_HOUR * 60) - SLOT_MINUTES;
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
  return new Date(`${dateStr}T${time}:00-07:00`);
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

  return res.json({ appointment });
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

  if (appointment.status === PickupAppointmentStatus.Cancelled) {
    return res.json({ appointment });
  }

  if (action === "cancel") {
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

    const updated = await prisma.pickupAppointment.update({
      where: { id: appointment.id },
      data: { status: PickupAppointmentStatus.Cancelled },
    });

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

  const disallowedStatuses: PickupAppointmentStatus[] = [
    PickupAppointmentStatus.Completed,
    PickupAppointmentStatus.NoShow,
    PickupAppointmentStatus.Cancelled,
  ];
  if (disallowedStatuses.includes(appointment.status as PickupAppointmentStatus)) {
    return res.status(409).json({ message: "Appointment cannot be rescheduled." });
  }

  const requiredSlots = appointment.orders.length > 6 ? 2 : 1;
  if (parsed.data.selectedSlots.length !== requiredSlots) {
    return res.status(400).json({ message: "Selected slots do not match appointment size." });
  }

  if (!ensureWithinBusinessHours(parsed.data.selectedDate, parsed.data.selectedSlots)) {
    return res.status(400).json({ message: "Selected time is outside business hours." });
  }

  if (!areSlotsContiguous(parsed.data.selectedSlots)) {
    return res.status(400).json({ message: "Selected slots must be consecutive." });
  }

  const orderedSlots = [...parsed.data.selectedSlots].sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
  );
  const startAt = makeDateTime(parsed.data.selectedDate, orderedSlots[0].startTime);
  const endAt = makeDateTime(parsed.data.selectedDate, orderedSlots[orderedSlots.length - 1].endTime);

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
