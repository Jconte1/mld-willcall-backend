"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestAddressContact = ingestAddressContact;
const client_1 = require("@prisma/client");
const createAcumaticaService_1 = require("../createAcumaticaService");
const fetchAddressContact_1 = __importDefault(require("../fetch/fetchAddressContact"));
const writeAddressContact_1 = __importDefault(require("../write/writeAddressContact"));
const denver_1 = require("../../time/denver");
const prisma = new client_1.PrismaClient();
function nowMs() {
    return Number(process.hrtime.bigint() / 1000000n);
}
async function handleOne(restService, baid) {
    const t0 = nowMs();
    const cutoffDenver = (0, denver_1.oneYearAgoDenver)(new Date());
    const cutoffLiteral = (0, denver_1.toDenverDateTimeOffsetLiteral)(cutoffDenver);
    const summaries = await prisma.erpOrderSummary.findMany({
        where: { baid, isActive: true, deliveryDate: { gte: cutoffDenver } },
        select: { orderNbr: true },
    });
    const orderNbrs = summaries.map((s) => s.orderNbr);
    if (!orderNbrs.length) {
        return {
            baid,
            erp: { totalFromERP: 0 },
            db: { addressesUpserted: 0, contactsUpserted: 0 },
            inspectedOrders: 0,
            timing: {
                erpFetchMs: 0,
                dbWritesMs: 0,
                totalMs: +(nowMs() - t0).toFixed(1),
            },
            note: "No active orders in the last year — nothing to fetch.",
        };
    }
    const tF1 = nowMs();
    const rows = await (0, fetchAddressContact_1.default)(restService, baid, {
        orderNbrs,
        cutoffLiteral,
    });
    const tF2 = nowMs();
    const tW1 = nowMs();
    const result = await (0, writeAddressContact_1.default)(baid, rows, { concurrency: 10 });
    const tW2 = nowMs();
    return {
        baid,
        erp: { totalFromERP: Array.isArray(rows) ? rows.length : 0 },
        db: result,
        inspectedOrders: orderNbrs.length,
        timing: {
            erpFetchMs: +(tF2 - tF1).toFixed(1),
            dbWritesMs: +(tW2 - tW1).toFixed(1),
            totalMs: +(nowMs() - t0).toFixed(1),
        },
    };
}
async function ingestAddressContact(baid) {
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    await restService.getToken();
    const result = await handleOne(restService, baid);
    return { count: 1, results: [result] };
}
