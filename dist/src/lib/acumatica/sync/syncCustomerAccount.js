"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCustomerDeltaSync = runCustomerDeltaSync;
const createAcumaticaService_1 = require("../createAcumaticaService");
const fetchOrderSummariesSince_1 = __importDefault(require("../fetch/fetchOrderSummariesSince"));
const fetchAddressContact_1 = __importDefault(require("../fetch/fetchAddressContact"));
const fetchPaymentInfo_1 = __importDefault(require("../fetch/fetchPaymentInfo"));
const fetchInventoryDetails_1 = __importDefault(require("../fetch/fetchInventoryDetails"));
const erpClient_1 = require("../../queue/erpClient");
const filterOrders_1 = __importDefault(require("../filter/filterOrders"));
const writeOrderSummaries_1 = require("../write/writeOrderSummaries");
const writeAddressContact_1 = __importDefault(require("../write/writeAddressContact"));
const writePaymentInfo_1 = __importDefault(require("../write/writePaymentInfo"));
const writeInventoryDetails_1 = __importDefault(require("../write/writeInventoryDetails"));
const denver_1 = require("../../time/denver");
const prisma_1 = require("../../prisma");
const INACTIVE_STATUSES = new Set([
    "Canceled",
    "Cancelled",
    "On Hold",
    "Pending Approval",
    "Rejected",
    "Pending Processing",
    "Credit Hold",
    "Completed",
    "Invoiced",
    "Expired",
    "Purchase Hold",
    "Not Approved",
    "Risk Hold",
]);
const DELTA_RECONCILE_MAX_CANDIDATES = Number(process.env.CUSTOMER_DELTA_RECONCILE_MAX_CANDIDATES ?? 50);
const DELTA_RECONCILE_CONCURRENCY = Number(process.env.CUSTOMER_DELTA_RECONCILE_CONCURRENCY ?? 5);
function fieldValue(row, key) {
    const value = row?.[key];
    if (value && typeof value === "object") {
        if ("value" in value)
            return value.value;
        if ("Value" in value)
            return value.Value;
    }
    return value;
}
function normalizeStatus(status) {
    const raw = String(status ?? "").trim();
    return raw || null;
}
async function fetchOrderHeaderStatus(restService, orderNbr) {
    if ((0, erpClient_1.shouldUseQueueErp)()) {
        const resp = await (0, erpClient_1.queueErpJobRequest)("/api/erp/jobs/orders/header", { orderNbr });
        const status = normalizeStatus(fieldValue(resp?.row ?? null, "Status"));
        return { found: Boolean(resp?.found), status };
    }
    const token = await restService.getToken();
    const safeOrderNbr = orderNbr.replace(/'/g, "''");
    const params = new URLSearchParams();
    params.set("$filter", `OrderNbr eq '${safeOrderNbr}'`);
    params.set("$select", "OrderNbr,Status,LocationID,ShipVia,CustomerID,LastModified");
    params.set("$top", "1");
    const url = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder?${params.toString()}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text || `Order header lookup failed (${response.status}) for ${orderNbr}`);
    }
    const parsed = text ? JSON.parse(text) : [];
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.value) ? parsed.value : [];
    const row = rows[0] ?? null;
    const status = normalizeStatus(fieldValue(row, "Status"));
    return { found: Boolean(row), status };
}
async function runWithConcurrency(items, concurrency, worker) {
    if (!items.length)
        return;
    const limit = Math.max(1, Math.min(concurrency, items.length));
    let index = 0;
    const runners = Array.from({ length: limit }, async () => {
        while (true) {
            const current = index++;
            if (current >= items.length)
                break;
            await worker(items[current], current);
        }
    });
    await Promise.all(runners);
}
async function runCustomerDeltaSync(baid, { sinceLiteral } = {}) {
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    if (!(0, erpClient_1.shouldUseQueueErp)()) {
        await restService.getToken();
    }
    const since = sinceLiteral ?? (0, denver_1.denver3amWindowStartLiteral)(new Date());
    console.log("[customer-sync][delta] fetch headers", { baid, since });
    const headerRows = await (0, fetchOrderSummariesSince_1.default)(restService, baid, {
        sinceLiteral: since,
        useOrderBy: true,
    });
    const { kept } = (0, filterOrders_1.default)(headerRows);
    console.log("[customer-sync][delta] headers", {
        baid,
        fetched: Array.isArray(headerRows) ? headerRows.length : 0,
        kept: kept.length,
    });
    const summary = await (0, writeOrderSummaries_1.upsertOrderSummariesDelta)(baid, kept, { concurrency: 10 });
    const seenOrders = new Set(kept.map((row) => String(row.orderNbr || "").trim().toUpperCase()).filter(Boolean));
    const localActive = await prisma_1.prisma.erpOrderSummary.findMany({
        where: { baid, isActive: true },
        select: { orderNbr: true },
        orderBy: [{ updatedAt: "asc" }],
        take: Math.max(1, DELTA_RECONCILE_MAX_CANDIDATES),
    });
    const staleCandidates = localActive
        .map((row) => String(row.orderNbr || "").trim().toUpperCase())
        .filter((orderNbr) => orderNbr && !seenOrders.has(orderNbr));
    const reconcileStats = {
        staleCandidates: staleCandidates.length,
        verifiedInactive: 0,
        verifiedStillActive: 0,
        notFound: 0,
        verifyFailed: 0,
    };
    if (staleCandidates.length) {
        console.log("[customer-sync][delta] reconcile stale active orders", {
            baid,
            staleCandidates: staleCandidates.length,
            maxCandidates: DELTA_RECONCILE_MAX_CANDIDATES,
        });
        await runWithConcurrency(staleCandidates, DELTA_RECONCILE_CONCURRENCY, async (orderNbr) => {
            try {
                const header = await fetchOrderHeaderStatus(restService, orderNbr);
                if (!header.found) {
                    reconcileStats.notFound += 1;
                    return;
                }
                const status = normalizeStatus(header.status);
                if (status && INACTIVE_STATUSES.has(status)) {
                    await prisma_1.prisma.erpOrderSummary.update({
                        where: { baid_orderNbr: { baid, orderNbr } },
                        data: {
                            status,
                            isActive: false,
                            lastSeenAt: new Date(),
                        },
                    });
                    reconcileStats.verifiedInactive += 1;
                    return;
                }
                reconcileStats.verifiedStillActive += 1;
            }
            catch (err) {
                reconcileStats.verifyFailed += 1;
                console.warn("[customer-sync][delta] stale order verify failed", {
                    baid,
                    orderNbr,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });
    }
    const activeOrders = kept
        .filter((row) => !INACTIVE_STATUSES.has(String(row.status || "")))
        .map((row) => row.orderNbr);
    let addressRows = [];
    let paymentRows = [];
    let inventoryRows = [];
    if (activeOrders.length) {
        console.log("[customer-sync][delta] details", {
            baid,
            activeOrders: activeOrders.length,
        });
        [addressRows, paymentRows, inventoryRows] = await Promise.all([
            (0, fetchAddressContact_1.default)(restService, baid, { orderNbrs: activeOrders }),
            (0, fetchPaymentInfo_1.default)(restService, baid, { orderNbrs: activeOrders }),
            (0, fetchInventoryDetails_1.default)(restService, baid, activeOrders),
        ]);
        await (0, writeAddressContact_1.default)(baid, addressRows);
        await (0, writePaymentInfo_1.default)(baid, paymentRows);
        await (0, writeInventoryDetails_1.default)(baid, inventoryRows);
    }
    else {
        console.log("[customer-sync][delta] skip details (no active orders)", { baid });
    }
    return {
        baid,
        sinceLiteral: since,
        fetchedHeaders: Array.isArray(headerRows) ? headerRows.length : 0,
        keptHeaders: kept.length,
        summary,
        reconciliation: reconcileStats,
        details: {
            orderNbrs: activeOrders.length,
            addressRows: Array.isArray(addressRows) ? addressRows.length : 0,
            paymentRows: Array.isArray(paymentRows) ? paymentRows.length : 0,
            inventoryRows: Array.isArray(inventoryRows) ? inventoryRows.length : 0,
        },
    };
}
