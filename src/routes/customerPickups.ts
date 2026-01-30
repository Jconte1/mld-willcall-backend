import { Router } from "express";
import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import { z } from "zod";
import {
  cancelAppointmentSilently,
  notifyCustomerCancelled,
  notifyCustomerScheduled,
} from "../notifications";

const prisma = new PrismaClient();
export const customerPickupsRouter = Router();

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const slotSchema = z.object({
  startTime: z.string().regex(TIME_RE),
  endTime: z.string().regex(TIME_RE),
});

const groupSchema = z.object({
  locationId: z.string().min(1),
  orderNbrs: z.array(z.string().min(1)).min(1),
  selectedDate: z.string().regex(DATE_RE),
  selectedSlots: z.array(slotSchema).min(1).max(2),
});

const createSchema = z
  .object({
    userId: z.string().min(1).optional(),
    orderReadyToken: z.string().min(1).optional(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().optional().default(""),
  phone: z.string().optional(),
  smsOptIn: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
  vehicleInfo: z.string().optional(),
  notes: z.string().optional(),
  groups: z.array(groupSchema).min(1),
  })
  .superRefine((data, ctx) => {
    if (!data.userId && !data.orderReadyToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "userId or orderReadyToken is required.",
      });
    }
  });

const availabilitySchema = z.object({
  locationId: z.string().min(1),
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
});

const cancelSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  suppressNotifications: z.boolean().optional(),
});

const updateOrdersSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  orderNbrs: z.array(z.string().min(1)),
});

const BLOCKING_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
];

type PendingAppointment = {
  userId: string | null;
  email: string;
  pickupReference: string;
  locationId: string;
  startAt: Date;
  endAt: Date;
  status: PickupAppointmentStatus;
  customerFirstName: string;
  customerLastName: string | null;
  customerEmail: string;
  customerPhone: string | null;
  smsOptIn: boolean;
  smsOptInAt: Date | null;
  smsOptInSource: string | null;
  smsOptInPhone: string | null;
  emailOptIn: boolean;
  emailOptInAt: Date | null;
  emailOptInSource: string | null;
  emailOptInEmail: string | null;
  vehicleInfo: string | null;
  customerNotes: string | null;
  orderNbrs: string[];
};

const DENVER_TZ = "America/Denver";
const OPEN_HOUR = 7;
const CLOSE_HOUR = 17;
const SLOT_MINUTES = 15;
const MIN_ADVANCE_MINUTES = 4 * 60;
const NEXT_DAY_EARLIEST_MINUTES = 10 * 60;

async function hasAccountAccess(
  userId: string,
  appointmentId: string
) {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { isDeveloper: true },
  });
  if (user?.isDeveloper) return true;

  const orderNbrs = await prisma.pickupAppointmentOrder.findMany({
    where: { appointmentId },
    select: { orderNbr: true },
  });
  if (!orderNbrs.length) return false;

  const summary = await prisma.erpOrderSummary.findFirst({
    where: { orderNbr: { in: orderNbrs.map((o) => o.orderNbr) } },
    select: { baid: true },
  });
  if (!summary?.baid) return false;

  const role = await prisma.accountUserRole.findFirst({
    where: { userId, baid: summary.baid, isActive: true },
    select: { id: true },
  });
  return Boolean(role);
}

function pad(num: number) {
  return String(num).padStart(2, "0");
}

function timeToMinutes(time: string) {
  const [hh, mm] = time.split(":").map((part) => Number(part));
  return hh * 60 + mm;
}

function minutesToTime(totalMinutes: number) {
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${pad(hh)}:${pad(mm)}`;
}

function parseDateOnly(dateStr: string) {
  // Anchor in Denver midday to avoid UTC date shifts.
  return new Date(`${dateStr}T12:00:00-07:00`);
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

function getDenverParts(date: Date) {
  const dateStr = formatDateInDenver(date);
  const timeStr = formatTimeInDenver(date);
  const [hour, minute] = timeStr.split(":").map((part) => Number(part));
  return {
    dateStr,
    hour,
    minute,
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: DENVER_TZ, weekday: "short" }).format(
      date
    ),
  };
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

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function isWeekend(dateStr: string) {
  const date = parseDateOnly(dateStr);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    weekday: "short",
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

function nextBusinessDateStr(dateStr: string) {
  let cursor = parseDateOnly(dateStr);
  while (true) {
    cursor = addMinutes(cursor, 24 * 60);
    const next = formatDateInDenver(cursor);
    if (!isWeekend(next)) return next;
  }
}

function ceilToSlot(minutes: number) {
  return Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}

function makeDateTime(dateStr: string, time: string) {
  return new Date(`${dateStr}T${time}:00-07:00`);
}

function buildSlotsForDate(
  dateStr: string,
  blocked: Set<string>,
  minStartMinutes: number | null
) {
  const slots = [];
  const startMinutes = OPEN_HOUR * 60;
  const lastStartMinutes = (CLOSE_HOUR * 60) - SLOT_MINUTES;

  for (let minutes = startMinutes; minutes <= lastStartMinutes; minutes += SLOT_MINUTES) {
    const startTime = minutesToTime(minutes);
    const endTime = minutesToTime(minutes + SLOT_MINUTES);
    const tooEarly = minStartMinutes != null && minutes < minStartMinutes;
    const available = !tooEarly && !blocked.has(startTime);
    slots.push({
      id: `slot-${dateStr.replace(/-/g, "")}-${startTime.replace(":", "")}`,
      startTime,
      endTime,
      available,
      capacityRemaining: available ? 1 : 0,
    });
  }
  return slots;
}

function ensureWithinBusinessHours(dateStr: string, slots: { startTime: string; endTime: string }[]) {
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

function getMinAllowedSlot(now: Date) {
  const parts = getDenverParts(now);
  const closeMinutes = CLOSE_HOUR * 60;
  const lastStartMinutes = closeMinutes - SLOT_MINUTES;
  const todayStr = parts.dateStr;

  if (isWeekend(todayStr)) {
    return { dateStr: nextBusinessDateStr(todayStr), minutes: OPEN_HOUR * 60 + MIN_ADVANCE_MINUTES };
  }

  const nowMinutes = parts.hour * 60 + parts.minute;
  let minMinutes = nowMinutes + MIN_ADVANCE_MINUTES;
  let minDateStr = todayStr;

  if (minMinutes > closeMinutes) {
    const remaining = minMinutes - closeMinutes;
    minDateStr = nextBusinessDateStr(todayStr);
    minMinutes = OPEN_HOUR * 60 + remaining;
  }

  if (minMinutes < OPEN_HOUR * 60) minMinutes = OPEN_HOUR * 60;
  if (minMinutes > lastStartMinutes) {
    minDateStr = nextBusinessDateStr(minDateStr);
    minMinutes = OPEN_HOUR * 60 + MIN_ADVANCE_MINUTES;
  }

  minMinutes = ceilToSlot(minMinutes);

  return { dateStr: minDateStr, minutes: minMinutes };
}

/**
 * GET /api/customer/pickups/availability?locationId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
customerPickupsRouter.get("/availability", async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid query parameters" });
  }

  const { locationId, from, to } = parsed.data;
  const now = new Date();
  const minAllowed = getMinAllowedSlot(now);
  console.log("[availability][min-advance]", {
    now: now.toISOString(),
    denverDate: formatDateInDenver(now),
    denverTime: formatTimeInDenver(now),
    from,
    to,
    locationId,
    minAllowedDate: minAllowed.dateStr,
    minAllowedMinutes: minAllowed.minutes,
    minAllowedTime: minutesToTime(minAllowed.minutes),
  });
  const rangeStart = parseDateOnly(from);
  const rangeEnd = addMinutes(parseDateOnly(to), 24 * 60);

  const appointments = await prisma.pickupAppointment.findMany({
    where: {
      locationId,
      status: { in: BLOCKING_STATUSES },
      startAt: { lt: rangeEnd },
      endAt: { gt: rangeStart },
    },
    select: { startAt: true, endAt: true },
  });

  const blockedByDate = new Map<string, Set<string>>();

  for (const appointment of appointments) {
    const startDateStr = formatDateInDenver(appointment.startAt);
    const startTime = formatTimeInDenver(appointment.startAt);
    const endTime = formatTimeInDenver(appointment.endAt);
    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);

    const blocked = blockedByDate.get(startDateStr) ?? new Set<string>();
    for (let minutes = startMinutes; minutes < endMinutes; minutes += SLOT_MINUTES) {
      blocked.add(minutesToTime(minutes));
    }
    blockedByDate.set(startDateStr, blocked);
  }

  const availability = [];
  for (let cursor = new Date(rangeStart); cursor < rangeEnd; cursor = addMinutes(cursor, 24 * 60)) {
    const dateStr = formatDateInDenver(cursor);
    const isBlackedOut = isWeekend(dateStr);
    const blocked = blockedByDate.get(dateStr) ?? new Set<string>();
    let minStartMinutes: number | null = null;
    if (dateStr < minAllowed.dateStr) {
      minStartMinutes = Infinity;
    } else if (dateStr === minAllowed.dateStr) {
      minStartMinutes = minAllowed.minutes;
    }

    availability.push({
      date: dateStr,
      slots: isBlackedOut ? [] : buildSlotsForDate(dateStr, blocked, minStartMinutes),
      isBlackedOut,
    });
  }

  return res.json({ availability });
});

/**
 * POST /api/customer/pickups
 */
customerPickupsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body", issues: parsed.error.issues });
  }

  const payload = parsed.data;
  const orderNbrs = Array.from(new Set(payload.groups.flatMap((group) => group.orderNbrs)));
  let orderReadyNoticeId: string | null = null;
  if (payload.orderReadyToken) {
    if (orderNbrs.length !== 1) {
      return res.status(400).json({ message: "Order-ready appointments must include one order." });
    }
    const token = await prisma.orderReadyAccessToken.findFirst({
      where: { token: payload.orderReadyToken, revokedAt: null },
      include: { orderReady: { select: { id: true, orderNbr: true } } },
    });
    if (!token || token.orderReady.orderNbr !== orderNbrs[0]) {
      return res.status(403).json({ message: "Invalid order-ready token." });
    }
    orderReadyNoticeId = token.orderReady.id;
  }

  const appointmentsToCreate: PendingAppointment[] = [];
  const ordersToCreate: { appointmentIndex: number; orderNbr: string }[] = [];

  for (const group of payload.groups) {
    if (!ensureWithinBusinessHours(group.selectedDate, group.selectedSlots)) {
      return res.status(400).json({ message: "Selected time is outside business hours." });
    }
    const minAllowed = getMinAllowedSlot(new Date());
    const selectedStartMinutes = timeToMinutes(group.selectedSlots[0].startTime);
    if (group.selectedDate < minAllowed.dateStr) {
      return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }
    if (group.selectedDate === minAllowed.dateStr && selectedStartMinutes < minAllowed.minutes) {
      return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }

    if (group.orderNbrs.length > 6 && group.selectedSlots.length !== 2) {
      return res.status(400).json({ message: "Two slots required for orders over 6." });
    }
    if (group.orderNbrs.length <= 6 && group.selectedSlots.length !== 1) {
      return res.status(400).json({ message: "One slot required for orders up to 6." });
    }

    if (!areSlotsContiguous(group.selectedSlots)) {
      return res.status(400).json({ message: "Selected slots must be consecutive." });
    }

    const orderedSlots = [...group.selectedSlots].sort(
      (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
    );
    const startAt = makeDateTime(group.selectedDate, orderedSlots[0].startTime);
    const endAt = makeDateTime(
      group.selectedDate,
      orderedSlots[orderedSlots.length - 1].endTime
    );

    appointmentsToCreate.push({
      userId: payload.userId ?? null,
      email: payload.email,
      pickupReference: group.orderNbrs.join(", "),
      locationId: group.locationId,
      startAt,
      endAt,
      status: PickupAppointmentStatus.Scheduled,
      customerFirstName: payload.firstName,
      customerLastName: payload.lastName || null,
      customerEmail: payload.email,
      customerPhone: payload.phone || null,
      smsOptIn: Boolean(payload.smsOptIn),
      smsOptInAt: payload.smsOptIn ? new Date() : null,
      smsOptInSource: payload.smsOptIn ? "confirmation-form" : null,
      smsOptInPhone: payload.smsOptIn ? payload.phone || null : null,
      emailOptIn: true,
      emailOptInAt: new Date(),
      emailOptInSource: "confirmation-form",
      emailOptInEmail: payload.email,
      vehicleInfo: payload.vehicleInfo || null,
      customerNotes: payload.notes || null,
      orderNbrs: group.orderNbrs,
    });
  }

  for (const [index, appointment] of appointmentsToCreate.entries()) {
    const conflict = await prisma.pickupAppointment.findFirst({
      where: {
        locationId: appointment.locationId,
        status: { in: BLOCKING_STATUSES },
        startAt: { lt: appointment.endAt },
        endAt: { gt: appointment.startAt },
      },
      select: { id: true },
    });
    if (conflict) {
      return res.status(409).json({ message: "Time slot no longer available." });
    }

    appointment.orderNbrs.forEach((orderNbr) => {
      ordersToCreate.push({ appointmentIndex: index, orderNbr });
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const createdAppointments = [];
    for (const appointment of appointmentsToCreate) {
      const createdAppointment = await tx.pickupAppointment.create({
        data: {
          userId: appointment.userId,
          email: appointment.email,
          pickupReference: appointment.pickupReference,
          locationId: appointment.locationId,
          startAt: appointment.startAt,
          endAt: appointment.endAt,
          status: appointment.status,
          customerFirstName: appointment.customerFirstName,
          customerLastName: appointment.customerLastName,
          customerEmail: appointment.customerEmail,
          customerPhone: appointment.customerPhone,
          smsOptIn: appointment.smsOptIn,
          smsOptInAt: appointment.smsOptInAt,
          smsOptInSource: appointment.smsOptInSource,
          smsOptInPhone: appointment.smsOptInPhone,
          emailOptIn: appointment.emailOptIn,
          emailOptInAt: appointment.emailOptInAt,
          emailOptInSource: appointment.emailOptInSource,
          emailOptInEmail: appointment.emailOptInEmail,
          vehicleInfo: appointment.vehicleInfo,
          customerNotes: appointment.customerNotes,
        },
      });

      const orderNbrs = appointment.orderNbrs.map((orderNbr) => ({
        appointmentId: createdAppointment.id,
        orderNbr,
      }));
      if (orderNbrs.length) {
        await tx.pickupAppointmentOrder.createMany({ data: orderNbrs, skipDuplicates: true });
      }

      createdAppointments.push(createdAppointment);
    }
    return createdAppointments;
  });

  if (orderReadyNoticeId && created.length > 0) {
    await prisma.orderReadyNotice.update({
      where: { id: orderReadyNoticeId },
      data: { scheduledAppointmentId: created[0].id },
    });
  }

  for (const [index, appointment] of created.entries()) {
    const orderNbrs = appointmentsToCreate[index]?.orderNbrs ?? [];
    try {
      await notifyCustomerScheduled(prisma, appointment, orderNbrs);
    } catch (err) {
      console.error("[notifications] schedule failed", err);
    }
  }

  return res.status(201).json({ appointments: created });
});

/**
 * PATCH /api/customer/pickups/:id/cancel
 */
customerPickupsRouter.patch("/:id/cancel", async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const appointment = await prisma.pickupAppointment.findUnique({
    where: { id: req.params.id },
  });
  if (!appointment) return res.status(404).json({ message: "Not found" });

  if (appointment.userId !== parsed.data.userId || appointment.email !== parsed.data.email) {
    const allowed = await hasAccountAccess(parsed.data.userId, appointment.id);
    if (!allowed) return res.status(403).json({ message: "Forbidden" });
  }

  if (appointment.status === PickupAppointmentStatus.Cancelled) {
    return res.json({ appointment });
  }

  const updated = await prisma.pickupAppointment.update({
    where: { id: appointment.id },
    data: { status: PickupAppointmentStatus.Cancelled },
  });

  const orderNbrs = await prisma.pickupAppointmentOrder.findMany({
    where: { appointmentId: updated.id },
    select: { orderNbr: true },
  });
  try {
    if (parsed.data.suppressNotifications) {
      await cancelAppointmentSilently(prisma, updated, orderNbrs.map((o) => o.orderNbr));
    } else {
      await notifyCustomerCancelled(prisma, updated, orderNbrs.map((o) => o.orderNbr));
    }
  } catch (err) {
    console.error("[notifications] cancel failed", err);
  }

  return res.json({ appointment: updated });
});

/**
 * PATCH /api/customer/pickups/:id/orders
 */
customerPickupsRouter.patch("/:id/orders", async (req, res) => {
  const parsed = updateOrdersSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const appointment = await prisma.pickupAppointment.findUnique({
    where: { id: req.params.id },
  });
  if (!appointment) return res.status(404).json({ message: "Not found" });

  if (appointment.userId !== parsed.data.userId || appointment.email !== parsed.data.email) {
    const allowed = await hasAccountAccess(parsed.data.userId, appointment.id);
    if (!allowed) return res.status(403).json({ message: "Forbidden" });
  }

  const nextOrderNbrs = Array.from(new Set(parsed.data.orderNbrs));
  const remaining = nextOrderNbrs.length;

  const nextStatus =
    remaining === 0 ? PickupAppointmentStatus.Cancelled : appointment.status;

  const nextEndAt =
    remaining === 0
      ? appointment.endAt
      : new Date(appointment.startAt.getTime() + (remaining > 6 ? 30 : 15) * 60_000);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.pickupAppointmentOrder.deleteMany({ where: { appointmentId: appointment.id } });
    if (nextOrderNbrs.length) {
      await tx.pickupAppointmentOrder.createMany({
        data: nextOrderNbrs.map((orderNbr) => ({
          appointmentId: appointment.id,
          orderNbr,
        })),
        skipDuplicates: true,
      });
    }

    return tx.pickupAppointment.update({
      where: { id: appointment.id },
      data: {
        status: nextStatus,
        endAt: nextEndAt,
      },
      include: { orders: true },
    });
  });

  return res.json({ appointment: updated });
});
