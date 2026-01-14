import { Router } from "express";
import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import { z } from "zod";
import { requireAuth, blockIfMustChangePassword } from "../middleware/auth";
import { expandLocationIds, normalizeLocationId } from "../lib/locationIds";
import {
  cancelAppointmentNotifications,
  notifyAppointmentCompleted,
  notifyAppointmentRescheduled,
  notifyOrderListChanged,
  notifyStaffCancelled,
  notifyStaffScheduled,
} from "../notifications";

const prisma = new PrismaClient();
export const pickupsRouter = Router();

const LOCATION_IDS = ["slc-hq", "slc-outlet", "boise-willcall"] as const;

pickupsRouter.use(requireAuth);
pickupsRouter.use(blockIfMustChangePassword);

const STATUS = z.enum([
  "Scheduled",
  "Confirmed",
  "InProgress",
  "Ready",
  "Completed",
  "Cancelled",
  "NoShow",
]);

function canAccessLocation(req: any, locationId: string): boolean {
  if (req.auth.role === "ADMIN") return true;
  return expandLocationIds(req.auth.locationAccess ?? []).includes(locationId);
}

/**
 * GET /api/staff/pickups
 * Optional query: locationId, status, from, to
 */
pickupsRouter.get("/", async (req, res) => {
  if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });
  const auth = req.auth;
  const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;

  if (locationId && !canAccessLocation(req, locationId)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const where: any = {};

  if (locationId) {
    const expanded = expandLocationIds([locationId]);
    where.locationId = { in: expanded };
  }

  if (status) {
    const parsed = STATUS.safeParse(status);
    if (!parsed.success) return res.status(400).json({ message: "Invalid status" });
    where.status = parsed.data as PickupAppointmentStatus;
  }

  if (from) {
    const fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ message: "Invalid from date" });
    }
    // Treat YYYY-MM-DD as a full-day lower bound in UTC.
    fromDate.setUTCHours(0, 0, 0, 0);
    where.startAt = { ...(where.startAt ?? {}), gte: fromDate };
  }

  if (to) {
    const toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ message: "Invalid to date" });
    }
    // Treat YYYY-MM-DD as a full-day upper bound in UTC.
    toDate.setUTCHours(23, 59, 59, 999);
    where.startAt = { ...(where.startAt ?? {}), lte: toDate };
  }

  // Staff scope by their locations (if no locationId explicitly provided)
  if (auth.role !== "ADMIN" && !locationId) {
    where.locationId = { in: expandLocationIds(auth.locationAccess ?? []) };
  }

  const pickups = await prisma.pickupAppointment.findMany({
    where,
    orderBy: { startAt: "asc" },
    include: { orders: true },
  });

  const normalized = pickups.map((pickup) => ({
    ...pickup,
    locationId: normalizeLocationId(pickup.locationId) ?? pickup.locationId,
  }));

  return res.json({ pickups: normalized });
});

/**
 * POST /api/staff/pickups
 * Body: { locationId, customerEmail, customerFirstName, customerLastName?, customerPhone?, startAt, endAt, status?, orderNbrs? }
 */
pickupsRouter.post("/", async (req, res) => {
  const body = z.object({
    locationId: z.enum(LOCATION_IDS),
    customerEmail: z.string().email(),
    customerFirstName: z.string().min(1),
    customerLastName: z.string().optional(),
    customerPhone: z.string().optional(),
    vehicleInfo: z.string().optional(),
    customerNotes: z.string().optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    status: STATUS.optional(),
    orderNbrs: z.array(z.string()).optional(),
    notifyCustomer: z.boolean().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  if (!canAccessLocation(req, body.data.locationId)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const customerEmail = body.data.customerEmail.toLowerCase();
  const user = await prisma.users.findUnique({ where: { email: customerEmail } });
  if (!user) {
    return res.status(404).json({ message: "Customer not found" });
  }

  const created = await prisma.$transaction(async (tx) => {
    const appointment = await tx.pickupAppointment.create({
      data: {
        userId: user.id,
        email: customerEmail,
        pickupReference: body.data.orderNbrs?.join(", ") ?? "",
        locationId: body.data.locationId,
        startAt: new Date(body.data.startAt),
        endAt: new Date(body.data.endAt),
        status: body.data.status ? (body.data.status as PickupAppointmentStatus) : undefined,
        customerFirstName: body.data.customerFirstName,
        customerLastName: body.data.customerLastName ?? null,
        customerEmail: customerEmail,
        customerPhone: body.data.customerPhone ?? null,
        vehicleInfo: body.data.vehicleInfo ?? null,
        customerNotes: body.data.customerNotes ?? null,
      },
    });

    if (body.data.orderNbrs?.length) {
      await tx.pickupAppointmentOrder.createMany({
        data: body.data.orderNbrs.map((orderNbr) => ({
          appointmentId: appointment.id,
          orderNbr,
        })),
        skipDuplicates: true,
      });
    }

    return appointment;
  });

  if (body.data.notifyCustomer) {
    try {
      await notifyStaffScheduled(prisma, created, body.data.orderNbrs ?? []);
    } catch (err) {
      console.error("[notifications] staff schedule failed", err);
    }
  }

  return res.status(201).json({ pickup: created });
});

/**
 * GET /api/staff/pickups/:id
 */
pickupsRouter.get("/:id", async (req, res) => {
  const pickup = await prisma.pickupAppointment.findUnique({
    where: { id: req.params.id },
    include: { orders: true },
  });
  if (!pickup) return res.status(404).json({ message: "Not found" });

  if (!canAccessLocation(req, pickup.locationId)) return res.status(403).json({ message: "Forbidden" });

  return res.json({
    pickup: {
      ...pickup,
      locationId: normalizeLocationId(pickup.locationId) ?? pickup.locationId,
    },
  });
});

/**
 * PATCH /api/staff/pickups/:id
 * Body: { status?, startAt?, endAt?, locationId?, customer fields?, orderNbrs? }
 */
pickupsRouter.patch("/:id", async (req, res) => {
  const body = z.object({
    status: STATUS.optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    locationId: z.string().optional(),
    customerFirstName: z.string().optional(),
    customerLastName: z.string().nullable().optional(),
    customerEmail: z.string().email().optional(),
    customerPhone: z.string().nullable().optional(),
    vehicleInfo: z.string().nullable().optional(),
    customerNotes: z.string().nullable().optional(),
    orderNbrs: z.array(z.string()).optional(),
    notifyCustomer: z.boolean().optional(),
    cancelReason: z.string().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ message: "Invalid request body" });

  const nextCustomerEmail = body.data.customerEmail?.toLowerCase();

  const existing = await prisma.pickupAppointment.findUnique({
    where: { id: req.params.id },
    include: { orders: true },
  });
  if (!existing) return res.status(404).json({ message: "Not found" });

  if (!canAccessLocation(req, existing.locationId)) return res.status(403).json({ message: "Forbidden" });

  const nextLocationId = body.data.locationId ? normalizeLocationId(body.data.locationId) : undefined;

  if (nextLocationId && !canAccessLocation(req, nextLocationId)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (body.data.orderNbrs) {
      await tx.pickupAppointmentOrder.deleteMany({ where: { appointmentId: existing.id } });
      const orderRows = body.data.orderNbrs.map((orderNbr) => ({
        appointmentId: existing.id,
        orderNbr,
      }));
      if (orderRows.length) {
        await tx.pickupAppointmentOrder.createMany({ data: orderRows, skipDuplicates: true });
      }
    }

    return tx.pickupAppointment.update({
      where: { id: req.params.id },
      data: {
        status: body.data.status ? (body.data.status as PickupAppointmentStatus) : undefined,
        startAt: body.data.startAt ? new Date(body.data.startAt) : undefined,
        endAt: body.data.endAt ? new Date(body.data.endAt) : undefined,
        locationId: nextLocationId ?? undefined,
        customerFirstName: body.data.customerFirstName,
        customerLastName: body.data.customerLastName ?? undefined,
        customerEmail: nextCustomerEmail ?? undefined,
        email: nextCustomerEmail ?? undefined,
        customerPhone: body.data.customerPhone ?? undefined,
        vehicleInfo: body.data.vehicleInfo ?? undefined,
        customerNotes: body.data.customerNotes ?? undefined,
      },
      include: { orders: true },
    });
  });

  const notifyCustomer = body.data.notifyCustomer ?? false;
  const cancelReason = body.data.cancelReason ?? null;
  const nextOrderNbrs = body.data.orderNbrs ?? existing.orders.map((o) => o.orderNbr);

  const timeChanged =
    (body.data.startAt && new Date(body.data.startAt).getTime() !== existing.startAt.getTime()) ||
    (body.data.endAt && new Date(body.data.endAt).getTime() !== existing.endAt.getTime());

  const locationChanged =
    body.data.locationId &&
    (normalizeLocationId(body.data.locationId) ?? body.data.locationId) !== existing.locationId;

  const statusChanged = body.data.status && body.data.status !== existing.status;
  const terminalStatusChange =
    statusChanged &&
    (body.data.status === "Cancelled" ||
      body.data.status === "Completed" ||
      body.data.status === "NoShow");

  const orderListChanged =
    Array.isArray(body.data.orderNbrs) &&
    (body.data.orderNbrs.length !== existing.orders.length ||
      body.data.orderNbrs.some((orderNbr) => !existing.orders.some((o) => o.orderNbr === orderNbr)));

  try {
    if (!terminalStatusChange && (timeChanged || locationChanged)) {
      if (notifyCustomer) {
        await notifyAppointmentRescheduled(
          prisma,
          updated,
          nextOrderNbrs,
          existing.startAt,
          existing.endAt,
          notifyCustomer,
          true,
          true
        );
      } else {
        await cancelAppointmentNotifications(prisma, updated.id);
      }
    }

    if (statusChanged && body.data.status === "Completed") {
      await notifyAppointmentCompleted(prisma, updated, nextOrderNbrs, notifyCustomer, true, true);
    }

    if (statusChanged && body.data.status === "Cancelled") {
      await notifyStaffCancelled(prisma, updated, nextOrderNbrs, cancelReason, notifyCustomer);
    }

    if (statusChanged && body.data.status === "NoShow") {
      await cancelAppointmentNotifications(prisma, updated.id);
    }

    if (orderListChanged) {
      await notifyOrderListChanged(prisma, updated, nextOrderNbrs, notifyCustomer, true, true);
    }
  } catch (err) {
    console.error("[notifications] staff update failed", err);
  }

  return res.json({
    pickup: {
      ...updated,
      locationId: normalizeLocationId(updated.locationId) ?? updated.locationId,
    },
  });
});
