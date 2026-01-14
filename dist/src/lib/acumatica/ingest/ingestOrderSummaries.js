"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestOrderSummaries = ingestOrderSummaries;
const createAcumaticaService_1 = require("../createAcumaticaService");
const fetchOrderSummaries_1 = __importDefault(require("../fetch/fetchOrderSummaries"));
const filterOrders_1 = __importDefault(require("../filter/filterOrders"));
const writeOrderSummaries_1 = require("../write/writeOrderSummaries");
function nowMs() {
    return Number(process.hrtime.bigint() / 1000000n);
}
async function handleOne(restService, baid) {
    const t0 = nowMs();
    const tF1 = nowMs();
    const rawRows = await (0, fetchOrderSummaries_1.default)(restService, baid);
    const tF2 = nowMs();
    const tS1 = nowMs();
    const { kept, counts, cutoff } = (0, filterOrders_1.default)(rawRows);
    const tS2 = nowMs();
    const tW1 = nowMs();
    const { inserted, updated, inactivated } = await (0, writeOrderSummaries_1.upsertOrderSummariesForBAID)(baid, kept, cutoff, { concurrency: 10 });
    const tW2 = nowMs();
    const tP1 = nowMs();
    const purged = await (0, writeOrderSummaries_1.purgeOldOrders)(cutoff);
    const tP2 = nowMs();
    return {
        baid,
        erp: counts,
        db: { inserted, updated, inactivated, purged },
        timing: {
            erpFetchMs: +(tF2 - tF1).toFixed(1),
            shapeMs: +(tS2 - tS1).toFixed(1),
            dbWritesMs: +(tW2 - tW1).toFixed(1),
            purgeMs: +(tP2 - tP1).toFixed(1),
            totalMs: +(nowMs() - t0).toFixed(1),
        },
    };
}
async function ingestOrderSummaries(baid) {
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    await restService.getToken();
    const result = await handleOne(restService, baid);
    return { count: 1, results: [result] };
}
