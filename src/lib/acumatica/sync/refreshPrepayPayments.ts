import { prisma } from "../../prisma";

import { createAcumaticaService } from "../createAcumaticaService";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import writePaymentInfo from "../write/writePaymentInfo";
import { toNumber } from "../../orders/orderHelpers";
import { shouldUseQueueErp } from "../../queue/erpClient";

const PREPAY_TERMS = new Set(["PP", "PPP", "PPT", "TRADE", "CONTRACT"]);

type RefreshPrepayPaymentsInput = {
  baid: string;
  orderNbrs: string[];
  context: string;
  forceRefreshAll?: boolean;
  minRefreshIntervalMs?: number;
};

function normalizeOrderNbr(value: string) {
  return String(value || "").trim();
}

export async function refreshPrepayPaymentsIfNeeded({
  baid,
  orderNbrs,
  context,
  forceRefreshAll = false,
  minRefreshIntervalMs,
}: RefreshPrepayPaymentsInput) {
  const uniqueOrderNbrs = Array.from(
    new Set(orderNbrs.map(normalizeOrderNbr).filter(Boolean))
  );

  if (!uniqueOrderNbrs.length) {
    console.info(`[payment-refresh][${context}] skip: no orderNbrs`);
    return { calledErp: false, eligibleOrderNbrs: [] as string[] };
  }

  const existingPayments = await prisma.erpOrderPayment.findMany({
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

  const paymentByOrder = new Map(
    existingPayments.map((payment) => [payment.orderNbr, payment])
  );

  const eligibleOrderNbrs: string[] = [];
  for (const orderNbr of uniqueOrderNbrs) {
    const payment = paymentByOrder.get(orderNbr);
    const terms = (payment?.terms ?? "").trim().toUpperCase();
    const unpaidBalance = toNumber(payment?.unpaidBalance ?? null) ?? 0;
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
  const effectiveMinRefreshIntervalMs =
    minRefreshIntervalMs ??
    Number(process.env.PAYMENT_FORCE_REFRESH_MIN_INTERVAL_MS ?? 180000);
  const nowMs = Date.now();

  const staleTargetOrderNbrs = targetOrderNbrs.filter((orderNbr) => {
    if (!forceRefreshAll) return true;
    const payment = paymentByOrder.get(orderNbr);
    if (!payment?.updatedAt) return true;
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

  const restService = createAcumaticaService();
  if (!shouldUseQueueErp()) {
    await restService.getToken();
  }

  console.info(`[payment-refresh][${context}] ERP_CALLED payment-info`, {
    baid,
    eligibleOrderNbrs: staleTargetOrderNbrs,
    count: staleTargetOrderNbrs.length,
    forceRefreshAll,
    minRefreshIntervalMs: effectiveMinRefreshIntervalMs,
  });

  const rows = await fetchPaymentInfo(restService, baid, { orderNbrs: staleTargetOrderNbrs });
  const writeResult = await writePaymentInfo(baid, rows);

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
