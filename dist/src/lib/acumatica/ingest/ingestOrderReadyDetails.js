"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshOrderReadyDetails = refreshOrderReadyDetails;
const client_1 = require("@prisma/client");
const node_crypto_1 = require("node:crypto");
const createAcumaticaService_1 = require("../createAcumaticaService");
const fetchAddressContact_1 = __importDefault(require("../fetch/fetchAddressContact"));
const fetchPaymentInfo_1 = __importDefault(require("../fetch/fetchPaymentInfo"));
const fetchInventoryDetails_1 = __importDefault(require("../fetch/fetchInventoryDetails"));
const writeAddressContact_1 = __importDefault(require("../write/writeAddressContact"));
const writePaymentInfo_1 = __importDefault(require("../write/writePaymentInfo"));
const writeInventoryDetails_1 = __importDefault(require("../write/writeInventoryDetails"));
const erpClient_1 = require("../../queue/erpClient");
const prisma = new client_1.PrismaClient();
const PICKUP_LOCATION_IDS = new Set([
    "slc-hq",
    "slc-outlet",
    "boise-willcall",
    "jackson-willcall",
    "provo-willcall",
]);
function normalizeErpLocationId(value) {
    const normalized = String(value ?? "").trim();
    if (!normalized)
        return null;
    if (PICKUP_LOCATION_IDS.has(normalized.toLowerCase())) {
        return "__PICKUP_ID_BLOCKED__";
    }
    return normalized;
}
async function refreshOrderReadyDetails(input) {
    const { baid, orderNbr, status, erpLocationId, shipVia, lastModified } = input;
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    if (!(0, erpClient_1.shouldUseQueueErp)()) {
        await restService.getToken();
    }
    const normalizedBaid = String(baid || "").trim();
    const normalizedOrderNbr = String(orderNbr || "").trim();
    const normalizedErpLocationId = normalizeErpLocationId(erpLocationId);
    if (normalizedErpLocationId === "__PICKUP_ID_BLOCKED__") {
        console.warn("[order-ready] blocked non-erp locationId write", {
            baid: normalizedBaid,
            orderNbr: normalizedOrderNbr,
            value: erpLocationId,
        });
    }
    const now = new Date();
    const summaryUpdate = {
        status: status ?? "Ready",
        shipVia: shipVia ?? null,
        lastSeenAt: now,
        isActive: true,
        updatedAt: now,
        lastAcumaticaPullAt: now,
    };
    if (normalizedErpLocationId && normalizedErpLocationId !== "__PICKUP_ID_BLOCKED__") {
        summaryUpdate.locationId = normalizedErpLocationId;
    }
    if (lastModified !== undefined) {
        summaryUpdate.lastAcumaticaModifiedAt = lastModified;
    }
    await prisma.erpOrderSummary.upsert({
        where: { baid_orderNbr: { baid: normalizedBaid, orderNbr: normalizedOrderNbr } },
        create: {
            id: (0, node_crypto_1.randomUUID)(),
            baid: normalizedBaid,
            orderNbr: normalizedOrderNbr,
            status: status ?? "Ready",
            locationId: normalizedErpLocationId && normalizedErpLocationId !== "__PICKUP_ID_BLOCKED__"
                ? normalizedErpLocationId
                : null,
            deliveryDate: null,
            jobName: null,
            shipVia: shipVia ?? null,
            customerName: "",
            buyerGroup: "",
            noteId: "",
            lastSeenAt: now,
            isActive: true,
            updatedAt: now,
            lastAcumaticaPullAt: now,
            lastAcumaticaModifiedAt: lastModified ?? null,
        },
        update: summaryUpdate,
    });
    const orderNbrs = [normalizedOrderNbr];
    const [addressRows, paymentRows, detailRows] = await Promise.all([
        (0, fetchAddressContact_1.default)(restService, normalizedBaid, { orderNbrs }),
        (0, fetchPaymentInfo_1.default)(restService, normalizedBaid, { orderNbrs }),
        (0, fetchInventoryDetails_1.default)(restService, normalizedBaid, orderNbrs),
    ]);
    await (0, writeAddressContact_1.default)(normalizedBaid, addressRows);
    await (0, writePaymentInfo_1.default)(normalizedBaid, paymentRows);
    await (0, writeInventoryDetails_1.default)(normalizedBaid, detailRows);
    return { orderNbr: normalizedOrderNbr, refreshedAt: now };
}
