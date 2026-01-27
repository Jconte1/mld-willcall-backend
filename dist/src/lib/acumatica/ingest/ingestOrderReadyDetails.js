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
const prisma = new client_1.PrismaClient();
async function refreshOrderReadyDetails(input) {
    const { baid, orderNbr, status, locationId, shipVia } = input;
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    await restService.getToken();
    const now = new Date();
    await prisma.erpOrderSummary.upsert({
        where: { baid_orderNbr: { baid, orderNbr } },
        create: {
            id: (0, node_crypto_1.randomUUID)(),
            baid,
            orderNbr,
            status: status ?? "Ready",
            locationId: locationId ?? null,
            deliveryDate: null,
            jobName: null,
            shipVia: shipVia ?? null,
            customerName: "",
            buyerGroup: "",
            noteId: "",
            lastSeenAt: now,
            isActive: true,
            updatedAt: now,
        },
        update: {
            status: status ?? "Ready",
            locationId: locationId ?? null,
            shipVia: shipVia ?? null,
            lastSeenAt: now,
            isActive: true,
            updatedAt: now,
        },
    });
    const orderNbrs = [orderNbr];
    const [addressRows, paymentRows, detailRows] = await Promise.all([
        (0, fetchAddressContact_1.default)(restService, baid, { orderNbrs }),
        (0, fetchPaymentInfo_1.default)(restService, baid, { orderNbrs }),
        (0, fetchInventoryDetails_1.default)(restService, baid, orderNbrs),
    ]);
    await (0, writeAddressContact_1.default)(baid, addressRows);
    await (0, writePaymentInfo_1.default)(baid, paymentRows);
    await (0, writeInventoryDetails_1.default)(baid, detailRows);
    return { orderNbr, refreshedAt: now };
}
