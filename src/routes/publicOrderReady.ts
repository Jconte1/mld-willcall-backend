import { Router } from "express";
import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import { z } from "zod";
import { toNumber } from "../lib/orders/orderHelpers";
import { refreshOrderReadyDetails } from "../lib/acumatica/ingest/ingestOrderReadyDetails";

const prisma = new PrismaClient();
export const publicOrderReadyRouter = Router();

const tokenSchema = z.object({
  token: z.string().min(1),
});

const SCHEDULED_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
  PickupAppointmentStatus.Completed,
];

const STALE_MS = 24 * 60 * 60 * 1000;

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

  const lines = await prisma.erpOrderLine.findMany({
    where: { orderNbr },
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
      unpaidBalance: toNumber(notice.unpaidBalance),
      termsId: notice.termsId,
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
        }
      : null,
    orderLines,
  });
});
