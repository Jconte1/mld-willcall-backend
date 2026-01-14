"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCustomerOrders = getCustomerOrders;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const CANCELLED = new Set(["Cancelled", "Canceled"]);
const HOLD = new Set(["On Hold", "Credit Hold", "Purchase Hold", "Risk Hold"]);
const COMPLETE = new Set(["Completed", "Invoiced"]);
function normalize(str) {
    return String(str || "").toLowerCase();
}
function inferOrderType(summary) {
    const hay = [summary.buyerGroup, summary.jobName, summary.shipVia]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (hay.includes("plumb"))
        return "Plumbing";
    if (hay.includes("hard"))
        return "Hardware";
    if (hay.includes("appliance") || hay.includes("appl"))
        return "Appliance";
    if (hay.includes("electrical"))
        return "Electrical";
    return summary.buyerGroup || summary.shipVia || "General";
}
function inferFulfillmentStatus(erpStatus, lineSummary) {
    if (CANCELLED.has(erpStatus))
        return "Cancelled";
    if (HOLD.has(erpStatus))
        return "On Hold";
    if (COMPLETE.has(erpStatus))
        return "Complete";
    if (lineSummary.totalLines > 0) {
        if (lineSummary.openLines === 0)
            return "Complete";
        if (lineSummary.openLines < lineSummary.totalLines)
            return "Partially Complete";
        return "Pending";
    }
    return "Processing";
}
function toNumber(value) {
    if (value == null)
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function inferPaymentStatus(unpaidBalance, status) {
    if (unpaidBalance != null && unpaidBalance > 0)
        return "Balance Due";
    if (status)
        return status;
    return null;
}
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
    const summaryIds = summaries.map((s) => s.id);
    const lines = summaryIds.length
        ? await prisma.erpOrderLine.findMany({
            where: { orderSummaryId: { in: summaryIds } },
            select: { orderSummaryId: true, openQty: true, warehouse: true },
        })
        : [];
    const lineStatsById = new Map();
    const warehousesById = new Map();
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
        const paymentStatus = inferPaymentStatus(unpaidBalance, summary.ErpOrderPayment?.status ?? null);
        const warehouses = Array.from(warehousesById.get(summary.id) ?? new Set()).sort();
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
        };
    });
}
