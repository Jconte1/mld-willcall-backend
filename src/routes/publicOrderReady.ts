import { Router } from "express";
import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import { z } from "zod";
import { toNumber } from "../lib/orders/orderHelpers";
import { refreshOrderReadyDetails } from "../lib/acumatica/ingest/ingestOrderReadyDetails";
import { fetchOrderReadyReport } from "../lib/acumatica/fetch/fetchOrderReadyReport";
import { buildOrderReadyLink } from "../notifications/links/buildLink";
import { rotateOrderReadyToken } from "../notifications/links/tokens";
import { sendEmail } from "../notifications/providers/email/sendEmail";
import { sendSms } from "../notifications/providers/sms/sendSms";
import { buildOrderReadyEmail } from "../notifications/templates/email/buildOrderReadyEmail";

const prisma = new PrismaClient();
export const publicOrderReadyRouter = Router();

const tokenSchema = z.object({
  token: z.string().min(1),
});

const resendSchema = z
  .object({
    orderNbr: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.email && !data.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "email or phone is required",
      });
      return;
    }
    if (data.email && data.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide only one of email or phone",
      });
    }
  });

const SCHEDULED_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
  PickupAppointmentStatus.Completed,
];

const STALE_MS = 60 * 60 * 1000;
const READY_LINES_STALE_MS = 60 * 60 * 1000;
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function getClientIp(req: any) {
  const xf = (req.headers["x-forwarded-for"] as string | undefined) || "";
  if (xf) return xf.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "";
}

async function checkLockout(key: string) {
  const row = await prisma.inviteLockout.findUnique({ where: { key } });
  if (!row?.lockedUntil) return { locked: false };
  if (row.lockedUntil.getTime() <= Date.now()) return { locked: false };
  return { locked: true, lockedUntil: row.lockedUntil };
}

async function recordAttempt(key: string, ok: boolean) {
  const now = new Date();
  const row = await prisma.inviteLockout.findUnique({ where: { key } });
  if (!row) {
    await prisma.inviteLockout.create({
      data: {
        key,
        attemptCount: ok ? 0 : 1,
        lastAttemptAt: now,
        lockedUntil: ok ? null : null,
      },
    });
    return;
  }

  if (ok) {
    await prisma.inviteLockout.update({
      where: { key },
      data: { attemptCount: 0, lastAttemptAt: now, lockedUntil: null },
    });
    return;
  }

  const withinWindow =
    row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < LOCKOUT_WINDOW_MS;
  const nextCount = withinWindow ? row.attemptCount + 1 : 1;
  const lockedUntil = nextCount >= LOCKOUT_MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_WINDOW_MS) : null;
  await prisma.inviteLockout.update({
    where: { key },
    data: { attemptCount: nextCount, lastAttemptAt: now, lockedUntil },
  });
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * GET /api/public/order-ready/:orderNbr?token=...
 */
publicOrderReadyRouter.get("/:orderNbr", async (req, res) => {
  const parsed = tokenSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid token" });
  }

  const orderNbr = req.params.orderNbr;
  const notice = await prisma.orderReadyNotice.findUnique({
    where: { orderNbr },
  });
  if (!notice) return res.status(404).json({ message: "Not found" });

  const token = await prisma.orderReadyAccessToken.findFirst({
    where: { orderReadyId: notice.id, token: parsed.data.token, revokedAt: null },
  });
  if (!token) return res.status(403).json({ message: "Invalid token" });

  let appointment = null;
  if (notice.scheduledAppointmentId) {
    appointment = await prisma.pickupAppointment.findUnique({
      where: { id: notice.scheduledAppointmentId },
      include: { orders: true },
    });
  } else {
    const appointmentOrder = await prisma.pickupAppointmentOrder.findFirst({
      where: {
        orderNbr,
        appointment: { status: { in: SCHEDULED_STATUSES } },
      },
      include: { appointment: { include: { orders: true } } },
      orderBy: { appointment: { startAt: "desc" } },
    });
    appointment = appointmentOrder?.appointment ?? null;
    if (appointment?.id) {
      await prisma.orderReadyNotice.update({
        where: { id: notice.id },
        data: { scheduledAppointmentId: appointment.id },
      });
    }
  }

  if (notice.baid) {
    const summary = await prisma.erpOrderSummary.findUnique({
      where: { baid_orderNbr: { baid: notice.baid, orderNbr } },
      select: { updatedAt: true },
    });
    const updatedAt = summary?.updatedAt ? new Date(summary.updatedAt).getTime() : 0;
    const isStale = !updatedAt || Date.now() - updatedAt > STALE_MS;
    if (isStale) {
      try {
        await refreshOrderReadyDetails({
          baid: notice.baid,
          orderNbr,
          status: notice.status,
          locationId: notice.locationId,
          shipVia: notice.shipVia,
        });
      } catch (err) {
        console.error("[order-ready] refresh failed", err);
      }
    }
  }

  const readyLinesStale =
    !notice.lastReadyAt || Date.now() - new Date(notice.lastReadyAt).getTime() > READY_LINES_STALE_MS;
  if (readyLinesStale) {
    await refreshReadyLines(notice.id, notice.orderNbr);
  }

  const readyLineRows = await prisma.orderReadyLine.findMany({
    where: { orderReadyId: notice.id },
    select: { inventoryId: true },
  });
  const readyInventoryIds = new Set(
    readyLineRows.map((row) => String(row.inventoryId || "").trim()).filter(Boolean)
  );

  const lines = await prisma.erpOrderLine.findMany({
    where: {
      orderNbr,
      ...(readyInventoryIds.size ? { inventoryId: { in: Array.from(readyInventoryIds) } } : {}),
    },
    select: {
      id: true,
      inventoryId: true,
      lineDescription: true,
      warehouse: true,
      openQty: true,
      orderQty: true,
      allocatedQty: true,
      isAllocated: true,
      amount: true,
      taxRate: true,
    },
    orderBy: { inventoryId: "asc" },
  });

  const orderLines = lines.map((line) => ({
    id: line.id,
    inventoryId: line.inventoryId,
    lineDescription: line.lineDescription,
    warehouse: line.warehouse,
    openQty: toNumber(line.openQty),
    orderQty: toNumber(line.orderQty),
    allocatedQty: toNumber(line.allocatedQty),
    isAllocated: line.isAllocated,
    amount: toNumber(line.amount),
    taxRate: toNumber(line.taxRate),
  }));

  const payment = await prisma.erpOrderPayment.findFirst({
    where: {
      orderNbr,
      ...(notice.baid ? { baid: notice.baid } : {}),
    },
    select: {
      orderTotal: true,
      unpaidBalance: true,
      terms: true,
      status: true,
    },
  });

  return res.json({
    orderReady: {
      orderNbr: notice.orderNbr,
      status: notice.status,
      orderType: notice.orderType,
      shipVia: notice.shipVia,
      qtyUnallocated: toNumber(notice.qtyUnallocated),
      qtyAllocated: toNumber(notice.qtyAllocated),
      customerId: notice.customerId,
      customerLocationId: notice.customerLocationId,
      contactName: notice.contactName,
      contactPhone: notice.contactPhone,
      contactEmail: notice.contactEmail,
      locationId: notice.locationId,
      smsOptIn: notice.smsOptIn,
    },
    appointment,
    payment: payment
      ? {
          orderTotal: toNumber(payment.orderTotal),
          unpaidBalance: toNumber(payment.unpaidBalance),
          terms: payment.terms,
          status: payment.status,
        }
      : null,
    orderLines,
  });
});

async function refreshReadyLines(orderReadyId: string, orderNbr: string) {
  const rows = await fetchOrderReadyReport();
  const inventoryIds = new Set<string>();
  for (const row of rows) {
    const rowOrderNbr = String(row.orderNbr || "").trim();
    if (!rowOrderNbr || rowOrderNbr !== orderNbr) continue;
    const inv = row.inventoryId ? String(row.inventoryId).trim() : "";
    if (inv) inventoryIds.add(inv);
  }

  await prisma.orderReadyLine.deleteMany({ where: { orderReadyId } });
  if (inventoryIds.size) {
    await prisma.orderReadyLine.createMany({
      data: Array.from(inventoryIds).map((inventoryId) => ({
        orderReadyId,
        orderNbr,
        inventoryId,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.orderReadyNotice.update({
    where: { id: orderReadyId },
    data: { lastReadyAt: new Date() },
  });
}

/**
 * POST /api/public/order-ready/resend
 * Body: { orderNbr, email? } OR { orderNbr, phone? }
 */
publicOrderReadyRouter.post("/resend", async (req, res) => {
  const parsed = resendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.json({
      ok: true,
      message: "If your information matches, you will receive a link shortly.",
    });
  }

  const orderNbr = parsed.data.orderNbr.trim();
  const email = parsed.data.email?.toLowerCase().trim() ?? null;
  const phone = normalizePhone(parsed.data.phone);
  const ip = getClientIp(req);

  const orderKey = `order-ready:${orderNbr}`;
  const ipKey = ip ? `order-ready-ip:${ip}` : "";
  const [orderLock, ipLock] = await Promise.all([
    checkLockout(orderKey),
    ipKey ? checkLockout(ipKey) : Promise.resolve({ locked: false }),
  ]);

  if (orderLock.locked || ipLock.locked) {
    return res.json({
      ok: true,
      message: "If your information matches, you will receive a link shortly.",
    });
  }

  const notice = await prisma.orderReadyNotice.findUnique({
    where: { orderNbr },
  });

  const contactEmail = (notice?.contactEmail || "").toLowerCase().trim() || null;
  const contactPhone = normalizePhone(notice?.contactPhone);
  const match =
    (email && contactEmail && email === contactEmail) ||
    (phone && contactPhone && phone === contactPhone);

  const matched = Boolean(match);
  await recordAttempt(orderKey, matched);
  if (ipKey) await recordAttempt(ipKey, matched);

  if (match && notice) {
    const tokenRow = await rotateOrderReadyToken(prisma, notice.id);
    const link = buildOrderReadyLink(orderNbr, tokenRow.token);

    if (email) {
      const message = buildOrderReadyEmail(orderNbr, link);
      await sendEmail(email, message.subject, message.body);
    } else if (phone) {
      const smsBody = `Order ${orderNbr} is ready for pickup. Schedule here: ${link}`;
      await sendSms(phone, smsBody);
    }

    await prisma.orderReadyNotice.update({
      where: { id: notice.id },
      data: {
        lastNotifiedAt: new Date(),
        nextEligibleNotifyAt: addDays(new Date(), 5),
      },
    });
  }

  return res.json({
    ok: true,
    message: "If your information matches, you will receive a link shortly.",
  });
});
