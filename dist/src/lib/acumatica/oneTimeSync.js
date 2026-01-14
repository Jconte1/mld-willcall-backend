"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOneTimeSync = runOneTimeSync;
const ingestOrderSummaries_1 = require("./ingest/ingestOrderSummaries");
const ingestPaymentInfo_1 = require("./ingest/ingestPaymentInfo");
const ingestInventoryDetails_1 = require("./ingest/ingestInventoryDetails");
const ingestAddressContact_1 = require("./ingest/ingestAddressContact");
const DEFAULT_RUN = [
    "order-summaries",
    "payment-info",
    "inventory-details",
    "address-contact",
];
const runners = {
    "order-summaries": ingestOrderSummaries_1.ingestOrderSummaries,
    "payment-info": ingestPaymentInfo_1.ingestPaymentInfo,
    "inventory-details": ingestInventoryDetails_1.ingestInventoryDetails,
    "address-contact": ingestAddressContact_1.ingestAddressContact,
};
async function runOneTimeSync(input) {
    const run = Array.isArray(input.run) && input.run.length ? input.run : DEFAULT_RUN;
    const tasks = run.filter((k) => runners[k]);
    const results = [];
    for (const key of tasks) {
        try {
            const body = await runners[key](input.baid);
            results.push({ route: key, status: 200, ok: true, body });
        }
        catch (err) {
            results.push({
                route: key,
                status: 500,
                ok: false,
                body: { message: String(err?.message || err) },
            });
        }
    }
    return { count: results.length, results };
}
