"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acumaticaRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
const oneTimeSync_1 = require("../lib/acumatica/oneTimeSync");
const resolveBaid_1 = require("../lib/acumatica/resolveBaid");
const ingestOrderSummaries_1 = require("../lib/acumatica/ingest/ingestOrderSummaries");
const ingestPaymentInfo_1 = require("../lib/acumatica/ingest/ingestPaymentInfo");
const ingestInventoryDetails_1 = require("../lib/acumatica/ingest/ingestInventoryDetails");
const ingestAddressContact_1 = require("../lib/acumatica/ingest/ingestAddressContact");
exports.acumaticaRouter = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
const SYNC_KEYS = [
    "order-summaries",
    "payment-info",
    "inventory-details",
    "address-contact",
];
const ONE_TIME_SYNC_BODY = zod_1.z.object({
    userId: zod_1.z.string().optional(),
    email: zod_1.z.string().email(),
    baid: zod_1.z.string().min(1),
    run: zod_1.z.array(zod_1.z.enum(SYNC_KEYS)).optional(),
});
const INGEST_BODY = zod_1.z.object({
    userId: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    baid: zod_1.z.string().optional(),
});
exports.acumaticaRouter.post("/one-time-sync", async (req, res) => {
    const parsed = ONE_TIME_SYNC_BODY.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request body" });
    }
    const result = await (0, oneTimeSync_1.runOneTimeSync)({
        userId: parsed.data.userId ?? null,
        email: parsed.data.email ?? null,
        baid: parsed.data.baid,
        run: parsed.data.run,
    });
    const allOk = Array.isArray(result?.results)
        ? result.results.every((r) => r?.ok === true)
        : true;
    if (allOk) {
        const now = new Date();
        await prisma.baidSyncState.upsert({
            where: { baid: parsed.data.baid },
            create: {
                baid: parsed.data.baid,
                inProgress: false,
                inProgressSince: null,
                lastAttemptAt: now,
                lastSyncAt: now,
                lastSuccessAt: now,
                lastErrorAt: null,
                lastErrorMessage: null,
            },
            update: {
                inProgress: false,
                inProgressSince: null,
                lastAttemptAt: now,
                lastSyncAt: now,
                lastSuccessAt: now,
                lastErrorAt: null,
                lastErrorMessage: null,
            },
        });
    }
    return res.json(result);
});
exports.acumaticaRouter.post("/ingest-order-summaries", async (req, res) => {
    const parsed = INGEST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        return res.status(400).json({ message: String(err?.message || err) });
    }
    const result = await (0, ingestOrderSummaries_1.ingestOrderSummaries)(baid);
    return res.json(result);
});
exports.acumaticaRouter.post("/ingest-payment-info", async (req, res) => {
    const parsed = INGEST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        return res.status(400).json({ message: String(err?.message || err) });
    }
    const result = await (0, ingestPaymentInfo_1.ingestPaymentInfo)(baid);
    return res.json(result);
});
exports.acumaticaRouter.post("/ingest-inventory-details", async (req, res) => {
    const parsed = INGEST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        return res.status(400).json({ message: String(err?.message || err) });
    }
    const result = await (0, ingestInventoryDetails_1.ingestInventoryDetails)(baid);
    return res.json(result);
});
exports.acumaticaRouter.post("/ingest-address-contact", async (req, res) => {
    const parsed = INGEST_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        return res.status(400).json({ message: String(err?.message || err) });
    }
    const result = await (0, ingestAddressContact_1.ingestAddressContact)(baid);
    return res.json(result);
});
