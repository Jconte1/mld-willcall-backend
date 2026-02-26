import { PrismaClient } from "@prisma/client";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import writePaymentInfo from "../write/writePaymentInfo";
import { shouldUseQueueErp } from "../../queue/erpClient";

const prisma = new PrismaClient();

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function handleOne(restService: any, baid: string) {
  const t0 = nowMs();

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  const summaries = await prisma.erpOrderSummary.findMany({
    where: { baid, isActive: true, deliveryDate: { gte: cutoff } },
    select: { orderNbr: true },
  });
  const orderNbrs = summaries.map((s) => s.orderNbr);
  console.log(
    `[ingest-payment-info] baid=${baid} activeSummaries=${orderNbrs.length}`
  );

  if (!orderNbrs.length) {
    console.log(`[ingest-payment-info] baid=${baid} skip (no active orders)`);
    return {
      baid,
      erp: { totalFromERP: 0 },
      db: { processedOrders: 0, paymentUpserts: 0, ms: 0 },
      inspectedOrders: 0,
      timing: { erpFetchMs: 0, dbWritesMs: 0, totalMs: +(nowMs() - t0).toFixed(1) },
      note: "No active orders in the last year — nothing to fetch.",
    };
  }

  const tF1 = nowMs();
  const rows = await fetchPaymentInfo(restService, baid, { orderNbrs });
  const tF2 = nowMs();
  console.log(
    `[ingest-payment-info] baid=${baid} fetchedRows=${Array.isArray(rows) ? rows.length : 0} inspectedOrders=${orderNbrs.length}`
  );

  const tW1 = nowMs();
  const result = await writePaymentInfo(baid, rows, { concurrency: 10 });
  const tW2 = nowMs();
  console.log(
    `[ingest-payment-info] baid=${baid} wrote paymentUpserts=${result.paymentUpserts ?? 0}`
  );

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

export async function ingestPaymentInfo(baid: string) {
  const restService = createAcumaticaService();
  if (!shouldUseQueueErp()) {
    await restService.getToken();
  }
  const result = await handleOne(restService, baid);
  return { count: 1, results: [result] };
}
