"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCustomerOrderDetail = getCustomerOrderDetail;
const client_1 = require("@prisma/client");
const orderHelpers_1 = require("./orderHelpers");
const prisma = new client_1.PrismaClient();
const ACTIVE_APPOINTMENT_STATUSES = [
    client_1.PickupAppointmentStatus.Scheduled,
    client_1.PickupAppointmentStatus.Confirmed,
    client_1.PickupAppointmentStatus.InProgress,
    client_1.PickupAppointmentStatus.Ready,
    client_1.PickupAppointmentStatus.Completed,
    client_1.PickupAppointmentStatus.NoShow,
];
async function getCustomerOrderDetail(baid, orderNbr) {
    const summary = await prisma.erpOrderSummary.findUnique({
        where: { baid_orderNbr: { baid, orderNbr } },
        include: {
            ErpOrderAddress: true,
            ErpOrderContact: true,
            ErpOrderPayment: true,
            ErpOrderLine: true,
        },
    });
    if (!summary)
        return null;
    const lines = summary.ErpOrderLine.map((line) => ({
        id: line.id,
        lineDescription: line.lineDescription,
        inventoryId: line.inventoryId,
        lineType: line.lineType,
        openQty: (0, orderHelpers_1.toNumber)(line.openQty),
        orderQty: (0, orderHelpers_1.toNumber)(line.orderQty),
        unitPrice: (0, orderHelpers_1.toNumber)(line.unitPrice),
        amount: (0, orderHelpers_1.toNumber)(line.amount),
        taxRate: (0, orderHelpers_1.toNumber)(line.taxRate),
        isAllocated: line.isAllocated,
        allocatedQty: line.allocatedQty,
        usrETA: line.usrETA,
        here: line.here,
        warehouse: line.warehouse,
    })).sort((a, b) => (a.inventoryId || "").localeCompare(b.inventoryId || ""));
    const lineSummary = lines.reduce((acc, line) => {
        acc.totalLines += 1;
        if (line.openQty != null && line.openQty > 0)
            acc.openLines += 1;
        return acc;
    }, { totalLines: 0, openLines: 0, closedLines: 0 });
    lineSummary.closedLines = lineSummary.totalLines - lineSummary.openLines;
    const orderType = (0, orderHelpers_1.inferOrderType)({
        buyerGroup: summary.buyerGroup,
        jobName: summary.jobName,
        shipVia: summary.shipVia,
    });
    const fulfillmentStatus = (0, orderHelpers_1.inferFulfillmentStatus)(summary.status, lineSummary);
    const unpaidBalance = (0, orderHelpers_1.toNumber)(summary.ErpOrderPayment?.unpaidBalance ?? null);
    const paymentStatus = (0, orderHelpers_1.inferPaymentStatus)(unpaidBalance, summary.ErpOrderPayment?.terms ?? null, summary.ErpOrderPayment?.status ?? null);
    const warehouses = Array.from(new Set(lines.map((l) => l.warehouse).filter(Boolean))).sort();
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
            orderType,
            fulfillmentStatus,
            paymentStatus,
            lineSummary,
            warehouses,
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
                orderTotal: (0, orderHelpers_1.toNumber)(summary.ErpOrderPayment.orderTotal),
                unpaidBalance,
                terms: summary.ErpOrderPayment.terms,
                status: summary.ErpOrderPayment.status,
            }
            : null,
        lines,
    };
}
