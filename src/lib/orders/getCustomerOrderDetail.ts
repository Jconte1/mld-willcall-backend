import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import {
  inferFulfillmentStatus,
  inferOrderType,
  inferPaymentStatus,
  toNumber,
} from "./orderHelpers";

const prisma = new PrismaClient();

const ACTIVE_APPOINTMENT_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
];

export async function getCustomerOrderDetail(baid: string, orderNbr: string) {
  const summary = await prisma.erpOrderSummary.findUnique({
    where: { baid_orderNbr: { baid, orderNbr } },
    include: {
      ErpOrderAddress: true,
      ErpOrderContact: true,
      ErpOrderPayment: true,
      ErpOrderLine: true,
    },
  });

  if (!summary) return null;

  const lines = summary.ErpOrderLine.map((line) => ({
    id: line.id,
    lineDescription: line.lineDescription,
    inventoryId: line.inventoryId,
    lineType: line.lineType,
    openQty: toNumber(line.openQty),
    orderQty: toNumber(line.orderQty),
    unitPrice: toNumber(line.unitPrice),
    amount: toNumber(line.amount),
    taxRate: toNumber(line.taxRate),
    isAllocated: line.isAllocated,
    allocatedQty: line.allocatedQty,
    usrETA: line.usrETA,
    here: line.here,
    warehouse: line.warehouse,
  })).sort((a, b) => (a.inventoryId || "").localeCompare(b.inventoryId || ""));

  const lineSummary = lines.reduce(
    (acc, line) => {
      acc.totalLines += 1;
      if (line.openQty != null && line.openQty > 0) acc.openLines += 1;
      return acc;
    },
    { totalLines: 0, openLines: 0, closedLines: 0 }
  );
  lineSummary.closedLines = lineSummary.totalLines - lineSummary.openLines;

  const orderType = inferOrderType({
    buyerGroup: summary.buyerGroup,
    jobName: summary.jobName,
    shipVia: summary.shipVia,
  });
  const fulfillmentStatus = inferFulfillmentStatus(summary.status, lineSummary);
  const unpaidBalance = toNumber(summary.ErpOrderPayment?.unpaidBalance ?? null);
  const paymentStatus = inferPaymentStatus(
    unpaidBalance,
    summary.ErpOrderPayment?.terms ?? null,
    summary.ErpOrderPayment?.status ?? null
  );

  const warehouses = Array.from(
    new Set(lines.map((l) => l.warehouse).filter(Boolean) as string[])
  ).sort();

  const appointmentOrder = await prisma.pickupAppointmentOrder.findFirst({
    where: {
      orderNbr,
      appointment: { status: { in: ACTIVE_APPOINTMENT_STATUSES } },
    },
    orderBy: { appointment: { startAt: "desc" } },
    include: { appointment: true },
  });

  const appointmentOrders = appointmentOrder?.appointment
    ? await prisma.pickupAppointmentOrder.findMany({
        where: { appointmentId: appointmentOrder.appointment.id },
        select: { orderNbr: true },
      })
    : [];

  const appointment = appointmentOrder?.appointment
    ? {
        id: appointmentOrder.appointment.id,
        status: appointmentOrder.appointment.status,
        startAt: appointmentOrder.appointment.startAt,
        endAt: appointmentOrder.appointment.endAt,
        locationId: appointmentOrder.appointment.locationId,
        orderNbrs: appointmentOrders.map((row) => row.orderNbr),
      }
    : null;

  const lastCompletedAppointment = await prisma.pickupAppointmentOrder.findFirst({
    where: {
      orderNbr,
      appointment: { status: PickupAppointmentStatus.Completed },
    },
    include: { appointment: true },
    orderBy: { appointment: { endAt: "desc" } },
  });

  const salesPerson =
    summary.salesPersonNumber
      ? await prisma.staffUser.findFirst({
          where: { salespersonNumber: summary.salesPersonNumber },
          select: {
            salespersonNumber: true,
            salespersonName: true,
            salespersonPhone: true,
            salespersonEmail: true,
          },
        })
      : null;

  return {
    summary: {
      id: summary.id,
      orderNbr: summary.orderNbr,
      status: summary.status,
      deliveryDate: summary.deliveryDate,
      locationId: summary.locationId,
      jobName: summary.jobName,
      shipVia: summary.shipVia,
      customerName: summary.customerName,
      buyerGroup: summary.buyerGroup,
      noteId: summary.noteId,
      salesPersonNumber: summary.salesPersonNumber ?? null,
      salesPerson: salesPerson
        ? {
            number: salesPerson.salespersonNumber ?? "",
            name: salesPerson.salespersonName ?? null,
            phone: salesPerson.salespersonPhone ?? null,
            email: salesPerson.salespersonEmail ?? null,
          }
        : null,
      orderType,
      fulfillmentStatus,
      paymentStatus,
      lineSummary,
      warehouses,
      lastPickupAt:
        lastCompletedAppointment?.appointment?.endAt ??
        lastCompletedAppointment?.appointment?.startAt ??
        null,
      appointment,
    },
    address: summary.ErpOrderAddress
      ? {
          addressLine1: summary.ErpOrderAddress.addressLine1,
          addressLine2: summary.ErpOrderAddress.addressLine2,
          city: summary.ErpOrderAddress.city,
          state: summary.ErpOrderAddress.state,
          postalCode: summary.ErpOrderAddress.postalCode,
        }
      : null,
    contact: summary.ErpOrderContact
      ? {
          deliveryEmail: summary.ErpOrderContact.deliveryEmail,
          siteNumber: summary.ErpOrderContact.siteNumber,
          osContact: summary.ErpOrderContact.osContact,
          confirmedVia: summary.ErpOrderContact.confirmedVia,
          confirmedWith: summary.ErpOrderContact.confirmedWith,
          sixWeekFailed: summary.ErpOrderContact.sixWeekFailed,
          tenDaySent: summary.ErpOrderContact.tenDaySent,
          threeDaySent: summary.ErpOrderContact.threeDaySent,
        }
      : null,
    payment: summary.ErpOrderPayment
      ? {
          orderTotal: toNumber(summary.ErpOrderPayment.orderTotal),
          unpaidBalance,
          terms: summary.ErpOrderPayment.terms,
          status: summary.ErpOrderPayment.status,
        }
      : null,
    lines,
  };
}
