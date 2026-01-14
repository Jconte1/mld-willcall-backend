"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = writePaymentInfo;
const client_1 = require("@prisma/client");
const node_crypto_1 = require("node:crypto");
const prisma = new client_1.PrismaClient();
async function writePaymentInfo(baid, rows, { concurrency = 10 } = {}) {
    const now = new Date();
    const safeRows = Array.isArray(rows) ? rows : [];
    console.log(`[upsertPaymentInfo] baid=${baid} incoming=${safeRows.length}`);
    const orderNbrs = [];
    for (const row of safeRows) {
        const orderNbr = str(val(row, "OrderNbr"));
        if (orderNbr)
            orderNbrs.push(orderNbr);
    }
    const uniqueNbrs = Array.from(new Set(orderNbrs));
    console.log(`[upsertPaymentInfo] baid=${baid} uniqueOrderNbrs=${uniqueNbrs.length}`);
    if (!uniqueNbrs.length) {
        console.log(`[upsertPaymentInfo] baid=${baid} nothing-to-map`);
        return { processedOrders: 0, paymentUpserts: 0, ms: 0 };
    }
    const summaries = await prisma.erpOrderSummary.findMany({
        where: { baid, orderNbr: { in: uniqueNbrs } },
        select: { id: true, orderNbr: true },
    });
    const idByNbr = new Map(summaries.map((s) => [s.orderNbr, s.id]));
    console.log(`[upsertPaymentInfo] baid=${baid} mappedSummaries=${summaries.length}`);
    let paymentUpserts = 0;
    const mappedOrderNbrs = new Set();
    const tasks = [];
    for (const row of safeRows) {
        const orderNbr = str(val(row, "OrderNbr"));
        if (!orderNbr)
            continue;
        const orderSummaryId = idByNbr.get(orderNbr);
        if (!orderSummaryId)
            continue;
        mappedOrderNbrs.add(orderNbr);
        const orderTotal = optDec(val(row, "OrderTotal"), 2);
        const unpaidBalance = optDec(val(row, "UnpaidBalance"), 2);
        const status = optStr(val(row, "Status"));
        const termsRaw = optStr(val(row, "Terms"));
        const terms = normalizeTerms(termsRaw);
        if (orderTotal == null && unpaidBalance == null && !terms)
            continue;
        tasks.push(async () => {
            await prisma.erpOrderPayment.upsert({
                where: { orderSummaryId },
                create: {
                    id: (0, node_crypto_1.randomUUID)(),
                    orderSummaryId,
                    baid,
                    orderNbr,
                    orderTotal,
                    unpaidBalance,
                    status: status ?? undefined,
                    terms,
                    updatedAt: now,
                },
                update: {
                    baid,
                    orderNbr,
                    orderTotal,
                    unpaidBalance,
                    status: status ?? undefined,
                    terms,
                    updatedAt: now,
                },
            });
            paymentUpserts += 1;
        });
    }
    if (!tasks.length) {
        console.log(`[upsertPaymentInfo] baid=${baid} mappedOrders=${mappedOrderNbrs.size} no-upserts`);
        return { processedOrders: mappedOrderNbrs.size, paymentUpserts: 0, ms: 0 };
    }
    const t0 = Date.now();
    await runWithConcurrency(tasks, concurrency, (fn) => fn());
    const ms = Date.now() - t0;
    console.log(`[upsertPaymentInfo] baid=${baid} processedOrders=${mappedOrderNbrs.size} paymentUpserts=${paymentUpserts} ms=${ms}`);
    return { processedOrders: mappedOrderNbrs.size, paymentUpserts, ms };
}
function val(obj, key) {
    const v = obj?.[key];
    if (v && typeof v === "object" && "value" in v)
        return v.value;
    return v;
}
function str(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
}
function optStr(v) {
    if (v == null)
        return null;
    if (typeof v === "string") {
        const s = v.trim();
        return s ? s : null;
    }
    if (typeof v === "object")
        return null;
    const s = String(v).trim();
    return s ? s : null;
}
function optDec(v, scale = 2) {
    if (v == null || v === "")
        return null;
    const n = Number(v);
    if (!isFinite(n))
        return null;
    return Number(n.toFixed(scale));
}
function normalizeTerms(v) {
    return v ?? "";
}
async function runWithConcurrency(items, limit, worker) {
    let i = 0;
    const n = Math.min(limit, items.length);
    const runners = Array.from({ length: n }, async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length)
                break;
            await worker(items[idx], idx);
        }
    });
    await Promise.all(runners);
}
