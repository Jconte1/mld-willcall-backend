"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshPrepayPaymentsIfNeeded = refreshPrepayPaymentsIfNeeded;
const prisma_1 = require("../../prisma");
const createAcumaticaService_1 = require("../createAcumaticaService");
const fetchPaymentInfo_1 = __importDefault(require("../fetch/fetchPaymentInfo"));
const writePaymentInfo_1 = __importDefault(require("../write/writePaymentInfo"));
const orderHelpers_1 = require("../../orders/orderHelpers");
const erpClient_1 = require("../../queue/erpClient");
const PREPAY_TERMS = new Set(["PP", "PPP", "PPT", "TRADE", "CONTRACT"]);
function normalizeOrderNbr(value) {
    return String(value || "").trim();
}
async function refreshPrepayPaymentsIfNeeded({ baid, orderNbrs, context, forceRefreshAll = false, minRefreshIntervalMs, }) {
    const uniqueOrderNbrs = Array.from(new Set(orderNbrs.map(normalizeOrderNbr).filter(Boolean)));
    if (!uniqueOrderNbrs.length) {
        console.info(`[payment-refresh][${context}] skip: no orderNbrs`);
        return { calledErp: false, eligibleOrderNbrs: [] };
    }
    const existingPayments = await prisma_1.prisma.erpOrderPayment.findMany({
        where: {
            baid,
            orderNbr: { in: uniqueOrderNbrs },
        },
        select: {
            orderNbr: true,
            terms: true,
            unpaidBalance: true,
            updatedAt: true,
        },
    });
    const paymentByOrder = new Map(existingPayments.map((payment) => [payment.orderNbr, payment]));
    const eligibleOrderNbrs = [];
    for (const orderNbr of uniqueOrderNbrs) {
        const payment = paymentByOrder.get(orderNbr);
        const terms = (payment?.terms ?? "").trim().toUpperCase();
        const unpaidBalance = (0, orderHelpers_1.toNumber)(payment?.unpaidBalance ?? null) ?? 0;
        const isPrepay = PREPAY_TERMS.has(terms);
        const hasBalanceDue = unpaidBalance > 0;
        console.info(`[payment-refresh][${context}] evaluate`, {
            baid,
            orderNbr,
            terms,
            unpaidBalance,
            isPrepay,
            hasBalanceDue,
        });
        if (isPrepay && hasBalanceDue) {
            eligibleOrderNbrs.push(orderNbr);
        }
    }
    const targetOrderNbrs = forceRefreshAll ? uniqueOrderNbrs : eligibleOrderNbrs;
    const effectiveMinRefreshIntervalMs = minRefreshIntervalMs ??
        Number(process.env.PAYMENT_FORCE_REFRESH_MIN_INTERVAL_MS ?? 180000);
    const nowMs = Date.now();
    const staleTargetOrderNbrs = targetOrderNbrs.filter((orderNbr) => {
        if (!forceRefreshAll)
            return true;
        const payment = paymentByOrder.get(orderNbr);
        if (!payment?.updatedAt)
            return true;
        const ageMs = nowMs - new Date(payment.updatedAt).getTime();
        return ageMs >= effectiveMinRefreshIntervalMs;
    });
    if (!staleTargetOrderNbrs.length) {
        console.info(`[payment-refresh][${context}] skip: no payment refresh needed`, {
            baid,
            totalOrders: uniqueOrderNbrs.length,
            forceRefreshAll,
            minRefreshIntervalMs: effectiveMinRefreshIntervalMs,
        });
        return { calledErp: false, eligibleOrderNbrs };
    }
    const restService = (0, createAcumaticaService_1.createAcumaticaService)();
    if (!(0, erpClient_1.shouldUseQueueErp)()) {
        await restService.getToken();
    }
    console.info(`[payment-refresh][${context}] ERP_CALLED payment-info`, {
        baid,
        eligibleOrderNbrs: staleTargetOrderNbrs,
        count: staleTargetOrderNbrs.length,
        forceRefreshAll,
        minRefreshIntervalMs: effectiveMinRefreshIntervalMs,
    });
    const rows = await (0, fetchPaymentInfo_1.default)(restService, baid, { orderNbrs: staleTargetOrderNbrs });
    const writeResult = await (0, writePaymentInfo_1.default)(baid, rows);
    console.info(`[payment-refresh][${context}] ERP_COMPLETED payment-info`, {
        baid,
        eligibleOrderNbrs: staleTargetOrderNbrs,
        fetchedRows: rows.length,
        writeResult,
        forceRefreshAll,
        minRefreshIntervalMs: effectiveMinRefreshIntervalMs,
    });
    return { calledErp: true, eligibleOrderNbrs };
}
