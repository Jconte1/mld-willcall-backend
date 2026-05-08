import { Router } from "express";
import { PickupAppointmentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  cancelAppointmentSilently,
  cancelAppointmentNotifications,
  notifyCustomerCancelled,
  notifyCustomerScheduled,
} from "../notifications";
import { makeDenverDateTime, parseDenverDateOnly } from "../lib/time/denverLocalDateTime";
import { getPickupHours } from "../lib/pickupHours";
import { isHolidayClosure } from "../lib/pickupClosures";

export const customerPickupsRouter = Router();

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const slotSchema = z.object({
  startTime: z.string().regex(TIME_RE),
  endTime: z.string().regex(TIME_RE),
});

const selectedItemSchema = z.object({
  lineId: z.string().optional(),
  inventoryId: z.string().min(1),
  qty: z.number().positive(),
  description: z.string().optional().nullable(),
  warehouse: z.string().optional().nullable(),
  maxQty: z.number().optional(),
});

const selectedItemsSchema = z.object({
  orderNbr: z.string().min(1),
  items: z.array(selectedItemSchema),
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
  selectedItems: z.array(selectedItemsSchema).optional(),
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
const PREPAY_TERMS = new Set(["PP", "PPP", "PPT", "TRADE", "CONTRACT"]);
const PREPAY_MIN_DUE = 1;

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

type CustomerOrderDetail = {
  orderNbr: string;
  payment: {
    orderTotal: number;
    otherFees: number;
    unpaidBalance: number;
    terms: string | null;
    status: string | null;
  };
  lines: Array<{
    id: string;
    inventoryId: string | null;
    lineDescription: string | null;
    openQty: number;
    orderQty: number;
    allocatedQty: number;
    isAllocated: boolean;
    amount: number;
    taxRate: number;
  }>;
};

const DENVER_TZ = "America/Denver";
const SLOT_MINUTES = 15;

function getMinAdvanceMinutes(locationId: string) {
  if (locationId === "boise-willcall") return 2 * 60;
  if (locationId === "jackson-willcall") return 0;
  return 4 * 60;
}

type ActiveOrderConflict = {
  orderNbr: string;
  appointmentId: string;
  status: PickupAppointmentStatus;
  startAt: Date;
  endAt: Date;
  displayAt: string;
};

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
  return parseDenverDateOnly(dateStr);
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

function formatDenverDateTime(input: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(input);
}

function normalizeOrderNbr(value: string) {
  return value.trim().toUpperCase();
}

function toNumber(value: Prisma.Decimal | number | string | null | undefined) {
  if (value == null) return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

async function getCustomerOrderDetail(orderNbrInput: string): Promise<CustomerOrderDetail | null> {
  const orderNbr = normalizeOrderNbr(orderNbrInput);
  const summary = await prisma.erpOrderSummary.findFirst({
    where: { orderNbr, isActive: true },
    orderBy: [{ updatedAt: "desc" }],
    include: {
      ErpOrderPayment: true,
      ErpOrderLine: true,
    },
  });

  if (!summary) return null;

  const lines = summary.ErpOrderLine.map((line) => ({
    id: line.id,
    inventoryId: line.inventoryId,
    lineDescription: line.lineDescription,
    openQty: toNumber(line.openQty),
    orderQty: toNumber(line.orderQty),
    allocatedQty: toNumber(line.allocatedQty),
    isAllocated: line.isAllocated,
    amount: toNumber(line.amount),
    taxRate: toNumber(line.taxRate),
  })).sort((a, b) => (a.inventoryId ?? "").localeCompare(b.inventoryId ?? ""));

  const paymentRow = summary.ErpOrderPayment;
  const payment = {
    orderTotal: toNumber(paymentRow?.orderTotal),
    otherFees: toNumber(paymentRow?.otherFees),
    unpaidBalance: toNumber(paymentRow?.unpaidBalance),
    terms: paymentRow?.terms ?? null,
    status: paymentRow?.status ?? null,
  };

  const lineAmountTotal = lines.reduce((sum, line) => sum + (line.amount || 0), 0);
  const lineTaxTotal = lines.reduce((sum, line) => {
    const orderQty = line.orderQty || 0;
    if (orderQty <= 0) return sum;
    const perUnitPreTax = (line.amount || 0) / orderQty;
    const perUnitTax = perUnitPreTax * ((line.taxRate || 0) / 100);
    return sum + perUnitTax * orderQty;
  }, 0);
  payment.otherFees = Math.max(
    0,
    Math.round((payment.orderTotal - lineAmountTotal - lineTaxTotal) * 100) / 100
  );

  return {
    orderNbr,
    payment,
    lines,
  };
}

function normalizeSelections(
  selectedItems: z.infer<typeof selectedItemsSchema>[] | undefined,
  allowedOrders: string[]
) {
  if (!selectedItems?.length) return [];
  const allowed = new Set(allowedOrders.map(normalizeOrderNbr));
  const byOrder = new Map<string, z.infer<typeof selectedItemSchema>[]>();

  for (const selection of selectedItems) {
    const orderNbr = normalizeOrderNbr(selection.orderNbr);
    if (!allowed.has(orderNbr)) continue;
    const items = selection.items.filter((item) => item.inventoryId && item.qty > 0);
    if (!items.length) continue;
    byOrder.set(orderNbr, [...(byOrder.get(orderNbr) ?? []), ...items]);
  }

  return Array.from(byOrder.entries()).map(([orderNbr, items]) => ({ orderNbr, items }));
}

function countSelectedItems(selectedItems: z.infer<typeof selectedItemsSchema>[]) {
  return selectedItems.reduce((sum, selection) => sum + selection.items.length, 0);
}

function findPrepayBlock(
  detail: CustomerOrderDetail,
  selectedItems: z.infer<typeof selectedItemsSchema> | undefined
) {
  if (detail.orderNbr.startsWith("R1")) return null;
  const terms = (detail.payment.terms ?? "").trim().toUpperCase();
  if (!PREPAY_TERMS.has(terms)) return null;

  const selectedMap = new Map(
    (selectedItems?.items ?? []).map((item) => [item.lineId ?? item.inventoryId, item])
  );
  const unpaidBalance = detail.payment.unpaidBalance;
  const otherFees = detail.payment.otherFees;
  const openLines = detail.lines.filter((line) => Math.max(0, line.openQty) > 0);
  const allOpenQtySelected =
    openLines.length > 0 &&
    openLines.every((line) => {
      const key = line.id || line.inventoryId || "";
      const selected = selectedMap.get(key);
      const selectedQty = selected ? selected.qty : 0;
      return selectedQty >= Math.max(0, line.openQty);
    });

  if (allOpenQtySelected) {
    const amountOwed = Math.max(0, unpaidBalance);
    if (amountOwed < PREPAY_MIN_DUE) return null;
    return {
      orderNbr: detail.orderNbr,
      amountOwed: Math.round(amountOwed * 100) / 100,
    };
  }

  const remainingGoodsWithTax = detail.lines.reduce((sum, line) => {
    const key = line.id || line.inventoryId || "";
    const selected = selectedMap.get(key);
    const selectedQty = selected ? selected.qty : 0;
    const remainingQty = Math.max(0, line.openQty - selectedQty);
    const orderQty = line.orderQty;
    if (orderQty <= 0 || remainingQty <= 0) return sum;
    const perUnitPreTax = line.amount / orderQty;
    const perUnitTax = perUnitPreTax * (line.taxRate / 100);
    return sum + remainingQty * (perUnitPreTax + perUnitTax);
  }, 0);

  const remainingWithFees = remainingGoodsWithTax + otherFees;
  const retainRequired = remainingWithFees * 0.5;
  const amountOwed = Math.max(0, unpaidBalance - retainRequired);

  if (amountOwed < PREPAY_MIN_DUE) return null;
  return {
    orderNbr: detail.orderNbr,
    amountOwed: Math.round(amountOwed * 100) / 100,
  };
}

async function findActiveOrderConflicts(orderNbrs: string[]): Promise<ActiveOrderConflict[]> {
  if (!orderNbrs.length) return [];

  const rows = await prisma.pickupAppointmentOrder.findMany({
    where: {
      orderNbr: { in: orderNbrs.map(normalizeOrderNbr) },
      appointment: {
        status: { in: BLOCKING_STATUSES },
      },
    },
    include: {
      appointment: {
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
        },
      },
    },
    orderBy: [{ appointment: { startAt: "asc" } }],
  });

  return rows.map((row) => ({
    orderNbr: row.orderNbr,
    appointmentId: row.appointmentId,
    status: row.appointment.status,
    startAt: row.appointment.startAt,
    endAt: row.appointment.endAt,
    displayAt: formatDenverDateTime(row.appointment.startAt),
  }));
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

function makeDateTime(dateStr: string, time: string) {
  return makeDenverDateTime(dateStr, time);
}

function buildSlotsForDate(
  locationId: string,
  dateStr: string,
  blocked: Set<string>,
  minStartMinutes: number | null
) {
  const slots = [];
  const { openHour, closeHour } = getPickupHours(locationId);
  const startMinutes = openHour * 60;
  const lastStartMinutes = (closeHour * 60) - SLOT_MINUTES;

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

function ensureWithinBusinessHours(
  locationId: string,
  dateStr: string,
  slots: { startTime: string; endTime: string }[]
) {
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

function getMinAllowedSlot(now: Date, locationId: string) {
  const parts = getDenverParts(now);
  let cursorDateStr = parts.dateStr;
  let cursorMinutes = parts.hour * 60 + parts.minute;
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
  const minAllowed = getMinAllowedSlot(now, locationId);
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

  const manualBlocks = await prisma.pickupManualBlock.findMany({
    where: {
      locationId,
      date: { gte: from, lte: to },
    },
    select: { date: true, startTime: true },
  });

  const blockedByDate = new Map<string, Set<string>>();

  for (const manualBlock of manualBlocks) {
    const blocked = blockedByDate.get(manualBlock.date) ?? new Set<string>();
    blocked.add(manualBlock.startTime);
    blockedByDate.set(manualBlock.date, blocked);
  }

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
    const isBlackedOut = isClosedDate(dateStr, locationId);
    const blocked = blockedByDate.get(dateStr) ?? new Set<string>();
    let minStartMinutes: number | null = null;
    if (dateStr < minAllowed.dateStr) {
      minStartMinutes = Infinity;
    } else if (dateStr === minAllowed.dateStr) {
      minStartMinutes = minAllowed.minutes;
    }

    availability.push({
      date: dateStr,
      slots: isBlackedOut ? [] : buildSlotsForDate(locationId, dateStr, blocked, minStartMinutes),
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
  const orderNbrs = Array.from(
    new Set(payload.groups.flatMap((group) => group.orderNbrs).map(normalizeOrderNbr).filter(Boolean))
  );
  const normalizedSelections = normalizeSelections(payload.selectedItems, orderNbrs);
  console.info("[customer-pickups][create] start", {
    orderNbrs,
    orderReady: Boolean(payload.orderReadyToken),
    selectedItemCount: countSelectedItems(normalizedSelections),
  });

  let orderReadyNoticeId: string | null = null;
  if (payload.orderReadyToken) {
    if (orderNbrs.length !== 1) {
      return res.status(400).json({ message: "Order-ready appointments must include one order." });
    }
    const token = await prisma.orderReadyAccessToken.findFirst({
      where: { token: payload.orderReadyToken, revokedAt: null },
      include: { orderReady: { select: { id: true, orderNbr: true } } },
    });
    if (!token || normalizeOrderNbr(token.orderReady.orderNbr) !== orderNbrs[0]) {
      return res.status(403).json({ message: "Invalid order-ready token." });
    }
    orderReadyNoticeId = token.orderReady.id;
  }

  const appointmentsToCreate: PendingAppointment[] = [];
  const ordersToCreate: { appointmentIndex: number; orderNbr: string }[] = [];

  const activeConflicts = await findActiveOrderConflicts(orderNbrs);
  if (activeConflicts.length) {
    const first = activeConflicts[0];
    return res.status(409).json({
      message: `Order ${first.orderNbr} already has an active pickup appointment. Please contact your salesperson if you have questions.`,
      code: "ORDER_ALREADY_SCHEDULED",
      conflicts: activeConflicts,
    });
  }

  const missingSelectionOrders = orderNbrs.filter(
    (orderNbr) => !(normalizedSelections.find((selection) => selection.orderNbr === orderNbr)?.items.length)
  );
  if (missingSelectionOrders.length) {
    console.warn("[customer-pickups][create] blocked: missing selected items", {
      orderNbrs: missingSelectionOrders,
    });
    return res.status(400).json({
      message: "Select at least one item from each order before scheduling pickup.",
      code: "SELECTED_ITEMS_REQUIRED",
      orderNbrs: missingSelectionOrders,
    });
  }

  const orderDetails = await Promise.all(orderNbrs.map((orderNbr) => getCustomerOrderDetail(orderNbr)));
  const detailMap = new Map<string, CustomerOrderDetail>();
  for (const detail of orderDetails) {
    if (detail) detailMap.set(detail.orderNbr, detail);
  }

  for (const orderNbr of orderNbrs) {
    const detail = detailMap.get(orderNbr);
    if (!detail) {
      console.warn("[customer-pickups][create] blocked: order not found", { orderNbr });
      return res.status(404).json({ message: `Order ${orderNbr} was not found.` });
    }
  }

  for (const selection of normalizedSelections) {
    const detail = detailMap.get(selection.orderNbr);
    if (!detail) {
      return res.status(404).json({ message: `Order ${selection.orderNbr} was not found.` });
    }
    const lineMap = new Map(detail.lines.map((line) => [line.id, line]));
    const inventoryMap = new Map(
      detail.lines
        .filter((line) => line.inventoryId)
        .map((line) => [String(line.inventoryId), line])
    );

    for (const item of selection.items) {
      const lineId = item.lineId ?? "";
      const line = lineMap.get(lineId) ?? inventoryMap.get(item.inventoryId);
      if (!line) {
        console.warn("[customer-pickups][create] blocked: selected line missing", {
          orderNbr: selection.orderNbr,
          inventoryId: item.inventoryId,
          lineId: item.lineId ?? null,
        });
        return res.status(400).json({
          message: `Selected line is not available on order ${selection.orderNbr}.`,
          code: "SELECTED_LINE_UNAVAILABLE",
        });
      }
      if (!line.isAllocated || line.allocatedQty <= 0) {
        console.warn("[customer-pickups][create] blocked: item not allocated", {
          orderNbr: selection.orderNbr,
          inventoryId: line.inventoryId,
          lineId: line.id,
          allocatedQty: line.allocatedQty,
          isAllocated: line.isAllocated,
        });
        return res.status(400).json({
          message: `Item ${line.inventoryId ?? "line"} is not ready for pickup on ${selection.orderNbr}.`,
          code: "SELECTED_LINE_NOT_READY",
        });
      }
      if (item.qty > line.openQty) {
        console.warn("[customer-pickups][create] blocked: item qty exceeds open qty", {
          orderNbr: selection.orderNbr,
          inventoryId: line.inventoryId,
          requestedQty: item.qty,
          openQty: line.openQty,
        });
        return res.status(400).json({
          message: `Selected quantity exceeds open quantity for ${selection.orderNbr}.`,
          code: "SELECTED_QTY_EXCEEDS_OPEN_QTY",
        });
      }
    }
  }

  for (const orderNbr of orderNbrs) {
    const detail = detailMap.get(orderNbr);
    if (!detail) continue;
    const selection = normalizedSelections.find((row) => row.orderNbr === orderNbr);
    const block = findPrepayBlock(detail, selection);
    if (block) {
      console.warn("[customer-pickups][create] blocked: prepay required", {
        ...block,
        terms: detail.payment.terms,
        unpaidBalance: detail.payment.unpaidBalance,
        otherFees: detail.payment.otherFees,
        paymentStatus: detail.payment.status,
      });
      return res.status(409).json({
        message: "Payment required before pickup.",
        code: "PREPAY_BLOCKED",
        orderNbr: block.orderNbr,
        amountOwed: block.amountOwed,
      });
    }
  }

  for (const group of payload.groups) {
    const groupOrderNbrs = Array.from(new Set(group.orderNbrs.map(normalizeOrderNbr).filter(Boolean)));
    if (!ensureWithinBusinessHours(group.locationId, group.selectedDate, group.selectedSlots)) {
      return res.status(400).json({ message: "Selected time is outside business hours." });
    }
    const minAllowed = getMinAllowedSlot(new Date(), group.locationId);
    const selectedStartMinutes = timeToMinutes(group.selectedSlots[0].startTime);
    if (group.selectedDate < minAllowed.dateStr) {
      return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }
    if (group.selectedDate === minAllowed.dateStr && selectedStartMinutes < minAllowed.minutes) {
      return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }

    if (groupOrderNbrs.length > 6 && group.selectedSlots.length !== 2) {
      return res.status(400).json({ message: "Two slots required for orders over 6." });
    }
    if (groupOrderNbrs.length <= 6 && group.selectedSlots.length !== 1) {
      return res.status(400).json({ message: "One slot required for orders up to 6." });
    }

    if (!areSlotsContiguous(group.selectedSlots)) {
      return res.status(400).json({ message: "Selected slots must be consecutive." });
    }

    const manualBlock = await prisma.pickupManualBlock.findFirst({
      where: {
        locationId: group.locationId,
        date: group.selectedDate,
        startTime: { in: group.selectedSlots.map((slot) => slot.startTime) },
      },
      select: { id: true },
    });
    if (manualBlock) {
      return res.status(409).json({ message: "Time slot no longer available." });
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
      pickupReference: groupOrderNbrs.join(", "),
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
      orderNbrs: groupOrderNbrs,
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

      const selectionsByOrder = new Map(
        normalizedSelections.map((selection) => [selection.orderNbr, selection.items])
      );
      const lineRows = appointment.orderNbrs.flatMap((orderNbr) => {
        const items = selectionsByOrder.get(orderNbr) ?? [];
        return items
          .filter((item) => item.inventoryId && item.qty > 0)
          .map((item) => ({
            appointmentId: createdAppointment.id,
            orderNbr,
            lineId: item.lineId ?? null,
            inventoryId: item.inventoryId,
            qtySelected: item.qty,
            lineDescription: item.description ?? null,
          }));
      });
      if (lineRows.length) {
        await tx.pickupAppointmentLine.createMany({ data: lineRows });
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

  console.info("[customer-pickups][create] success", {
    appointmentIds: created.map((appointment) => appointment.id),
    orderNbrs,
    orderReady: Boolean(orderReadyNoticeId),
  });

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

  const existingOrders = await prisma.pickupAppointmentOrder.findMany({
    where: { appointmentId: appointment.id },
    select: { orderNbr: true },
  });
  const existingOrderNbrs = existingOrders.map((order) => order.orderNbr);

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

  if (nextStatus === PickupAppointmentStatus.Cancelled) {
    try {
      await cancelAppointmentNotifications(prisma, updated.id);
      await notifyCustomerCancelled(prisma, updated, existingOrderNbrs);
    } catch (err) {
      console.error("[notifications] cancel failed", err);
    }
  }

  return res.json({ appointment: updated });
});
