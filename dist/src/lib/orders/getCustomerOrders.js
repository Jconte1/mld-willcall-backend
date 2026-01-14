"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCustomerOrders = getCustomerOrders;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const orderHelpers_1 = require("./orderHelpers");
const ACTIVE_APPOINTMENT_STATUSES = [
    client_1.PickupAppointmentStatus.Scheduled,
    client_1.PickupAppointmentStatus.Confirmed,
    client_1.PickupAppointmentStatus.InProgress,
    client_1.PickupAppointmentStatus.Ready,
    client_1.PickupAppointmentStatus.Completed,
    client_1.PickupAppointmentStatus.NoShow,
];
async function getCustomerOrders(baid) {
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
    const orderNbrsByAppointment = new Map();
    for (const row of appointmentOrders) {
        const set = orderNbrsByAppointment.get(row.appointmentId) ?? new Set();
        set.add(row.orderNbr);
        orderNbrsByAppointment.set(row.appointmentId, set);
    }
    const appointmentByOrder = new Map();
    for (const row of appointmentOrders) {
        const appointment = row.appointment;
        if (!appointment)
            continue;
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
    const lineStatsById = new Map();
    const warehousesById = new Map();
    const readinessById = new Map();
    for (const line of lines) {
        const current = lineStatsById.get(line.orderSummaryId) || {
            totalLines: 0,
            openLines: 0,
            closedLines: 0,
        };
        current.totalLines += 1;
        const openQty = line.openQty == null ? 0 : Number(line.openQty);
        if (openQty > 0)
            current.openLines += 1;
        lineStatsById.set(line.orderSummaryId, current);
        if (line.warehouse) {
            const set = warehousesById.get(line.orderSummaryId) || new Set();
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
        const orderType = (0, orderHelpers_1.inferOrderType)(summary);
        const fulfillmentStatus = (0, orderHelpers_1.inferFulfillmentStatus)(summary.status, stats);
        const unpaidBalance = (0, orderHelpers_1.toNumber)(summary.ErpOrderPayment?.unpaidBalance);
        const paymentStatus = (0, orderHelpers_1.inferPaymentStatus)(unpaidBalance, summary.ErpOrderPayment?.terms ?? null, summary.ErpOrderPayment?.status ?? null);
        const warehouses = Array.from(warehousesById.get(summary.id) ?? new Set()).sort();
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
            appointment: appointmentByOrder.get(summary.orderNbr) ?? null,
        };
    });
}
