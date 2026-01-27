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
const filterOrders_1 = __importDefault(require("../filter/filterOrders"));
const writeOrderSummaries_1 = require("../write/writeOrderSummaries");
const writeAddressContact_1 = __importDefault(require("../write/writeAddressContact"));
const writePaymentInfo_1 = __importDefault(require("../write/writePaymentInfo"));
const writeInventoryDetails_1 = __importDefault(require("../write/writeInventoryDetails"));
const denver_1 = require("../../time/denver");
const INACTIVE_STATUSES = new Set([
    "Canceled",
    "Cancelled",
    "On Hold",
    "Pending Approval",
    "Rejected",
    "Pending Processing",
    "Awaiting Payment",
    "Credit Hold",
    "Completed",
    "Invoiced",
    "Expired",
    "Purchase Hold",
    "Not Approved",
    "Risk Hold",
]);
async function runCustomerDeltaSync(baid, { sinceLiteral } = {}) {
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    await restService.getToken();
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
        details: {
            orderNbrs: activeOrders.length,
            addressRows: Array.isArray(addressRows) ? addressRows.length : 0,
            paymentRows: Array.isArray(paymentRows) ? paymentRows.length : 0,
            inventoryRows: Array.isArray(inventoryRows) ? inventoryRows.length : 0,
        },
    };
}
