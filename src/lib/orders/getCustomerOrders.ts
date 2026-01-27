import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";

const prisma = new PrismaClient();

import {
  inferFulfillmentStatus,
  inferOrderType,
  inferPaymentStatus,
  toNumber,
} from "./orderHelpers";

type LineStats = {
  totalLines: number;
  openLines: number;
  closedLines: number;
};

type OrderSummaryView = {
  id: string;
  orderNbr: string;
  deliveryDate: Date | null;
  status: string;
  jobName: string | null;
  customerName: string;
  buyerGroup: string | null;
  shipVia: string | null;
  locationId: string | null;
  orderType: string;
  fulfillmentStatus: string;
  paymentStatus: string | null;
  warehouses: string[];
  lineSummary: LineStats;
  isPickupReady: boolean;
  lastPickupAt: Date | null;
  appointment: {
    id: string;
    status: PickupAppointmentStatus;
    startAt: Date;
    endAt: Date;
    locationId: string;
    orderNbrs: string[];
  } | null;
};

const ACTIVE_APPOINTMENT_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
];

export async function getCustomerOrders(baid: string): Promise<OrderSummaryView[]> {
  const summaries = await prisma.erpOrderSummary.findMany({
    where: { baid, isActive: true },
    orderBy: [{ deliveryDate: "asc" }, { orderNbr: "asc" }],
    select: {
      id: true,
      orderNbr: true,
      deliveryDate: true,
      status: true,
      jobName: true,
      customerName: true,
      buyerGroup: true,
      shipVia: true,
      locationId: true,
      ErpOrderPayment: {
        select: {
          unpaidBalance: true,
          orderTotal: true,
          terms: true,
          status: true,
        },
      },
    },
  });

  const orderNbrs = summaries.map((summary) => summary.orderNbr);
  const appointmentOrders = orderNbrs.length
    ? await prisma.pickupAppointmentOrder.findMany({
        where: {
          orderNbr: { in: orderNbrs },
          appointment: { status: { in: ACTIVE_APPOINTMENT_STATUSES } },
        },
        include: { appointment: true },
      })
    : [];

  const completedAppointmentOrders = orderNbrs.length
    ? await prisma.pickupAppointmentOrder.findMany({
        where: {
          orderNbr: { in: orderNbrs },
          appointment: { status: PickupAppointmentStatus.Completed },
        },
        include: { appointment: true },
      })
    : [];

  const orderNbrsByAppointment = new Map<string, Set<string>>();
  for (const row of appointmentOrders) {
    const set = orderNbrsByAppointment.get(row.appointmentId) ?? new Set<string>();
    set.add(row.orderNbr);
    orderNbrsByAppointment.set(row.appointmentId, set);
  }

  const appointmentByOrder = new Map<string, OrderSummaryView["appointment"]>();
  for (const row of appointmentOrders) {
    const appointment = row.appointment;
    if (!appointment) continue;
    const existing = appointmentByOrder.get(row.orderNbr);
    if (!existing || appointment.startAt > existing.startAt) {
      appointmentByOrder.set(row.orderNbr, {
        id: appointment.id,
        status: appointment.status,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        locationId: appointment.locationId,
        orderNbrs: Array.from(orderNbrsByAppointment.get(appointment.id) ?? []),
      });
    }
  }

  const lastCompletedByOrder = new Map<string, Date>();
  for (const row of completedAppointmentOrders) {
    const appointment = row.appointment;
    if (!appointment) continue;
    const current = lastCompletedByOrder.get(row.orderNbr);
    const next = appointment.endAt ?? appointment.startAt;
    if (!current || next > current) {
      lastCompletedByOrder.set(row.orderNbr, next);
    }
  }

  const summaryIds = summaries.map((s) => s.id);
  const lines = summaryIds.length
    ? await prisma.erpOrderLine.findMany({
        where: { orderSummaryId: { in: summaryIds } },
        select: {
          orderSummaryId: true,
          openQty: true,
          warehouse: true,
          isAllocated: true,
          allocatedQty: true,
        },
      })
    : [];

  const lineStatsById = new Map<string, LineStats>();
  const warehousesById = new Map<string, Set<string>>();
  const readinessById = new Map<string, { hasOpen: boolean; hasReady: boolean }>();
  for (const line of lines) {
    const current = lineStatsById.get(line.orderSummaryId) || {
      totalLines: 0,
      openLines: 0,
      closedLines: 0,
    };
    current.totalLines += 1;
    const openQty = line.openQty == null ? 0 : Number(line.openQty);
    if (openQty > 0) current.openLines += 1;
    lineStatsById.set(line.orderSummaryId, current);

    if (line.warehouse) {
      const set = warehousesById.get(line.orderSummaryId) || new Set<string>();
      set.add(line.warehouse);
      warehousesById.set(line.orderSummaryId, set);
    }

    const readiness = readinessById.get(line.orderSummaryId) || {
      hasOpen: false,
      hasReady: false,
    };
    if (openQty > 0) {
      readiness.hasOpen = true;
      if (line.isAllocated && (line.allocatedQty ?? 0) > 0) {
        readiness.hasReady = true;
      }
    }
    readinessById.set(line.orderSummaryId, readiness);
  }

  for (const stats of lineStatsById.values()) {
    stats.closedLines = stats.totalLines - stats.openLines;
  }

  return summaries.map((summary) => {
    const stats = lineStatsById.get(summary.id) || {
      totalLines: 0,
      openLines: 0,
      closedLines: 0,
    };

    const orderType = inferOrderType(summary);
    const fulfillmentStatus = inferFulfillmentStatus(summary.status, stats);
    const unpaidBalance = toNumber(summary.ErpOrderPayment?.unpaidBalance);
    const paymentStatus = inferPaymentStatus(
      unpaidBalance,
      summary.ErpOrderPayment?.terms ?? null,
      summary.ErpOrderPayment?.status ?? null
    );
    const warehouses = Array.from(warehousesById.get(summary.id) ?? new Set<string>()).sort();
    const readiness = readinessById.get(summary.id) || { hasOpen: false, hasReady: false };
    const isPickupReady = !readiness.hasOpen || readiness.hasReady;
    return {
      id: summary.id,
      orderNbr: summary.orderNbr,
      deliveryDate: summary.deliveryDate,
      status: summary.status,
      jobName: summary.jobName,
      customerName: summary.customerName,
      buyerGroup: summary.buyerGroup,
      shipVia: summary.shipVia,
      locationId: summary.locationId,
      orderType: orderType,
      fulfillmentStatus,
      paymentStatus,
      warehouses,
      lineSummary: stats,
      isPickupReady,
      lastPickupAt: lastCompletedByOrder.get(summary.orderNbr) ?? null,
      appointment: appointmentByOrder.get(summary.orderNbr) ?? null,
    };
  });
}
