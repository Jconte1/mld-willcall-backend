import { PrismaClient } from "@prisma/client";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import writeInventoryDetails from "../write/writeInventoryDetails";
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
  console.log(`[inventoryRoute] baid=${baid} candidateOrders=${orderNbrs.length}`);

  if (!orderNbrs.length) {
    return {
      baid,
      erp: { totalFromERP: 0 },
      db: {
        ordersConsidered: 0,
        ordersAffected: 0,
        linesKept: 0,
        linesDeleted: 0,
        linesInserted: 0,
        scan: {
          ordersScanned: 0,
          ordersWithoutNbr: 0,
          ordersWithNoDetails: 0,
          linesKept: 0,
          linesDroppedEmpty: 0,
        },
      },
      inspectedOrders: 0,
      timing: { erpFetchMs: 0, dbLinesMs: 0, totalMs: +(nowMs() - t0).toFixed(1) },
      note: "No active orders in the last year — nothing to fetch.",
    };
  }

  let rows: any[] = [];
  let fetchErr: string | null = null;
  const tF1 = nowMs();
  try {
    rows = await fetchInventoryDetails(restService, baid, orderNbrs, {
      batchSize: Number(process.env.LINES_BATCH_SIZE || 24),
      pool: Number(process.env.LINES_POOL || 12),
      maxSockets: Number(process.env.LINES_MAX_SOCKETS || 16),
      maxUrl: Number(process.env.ACUMATICA_MAX_URL || 7000),
      retries: Number(process.env.LINES_RETRIES || 3),
    });
  } catch (e: any) {
    fetchErr = String(e?.message || e);
    console.error(`[inventoryRoute] fetch error baid=${baid}:`, fetchErr);
  }
  const tF2 = nowMs();

  if (fetchErr) {
    return {
      baid,
      error: fetchErr,
      erp: { totalFromERP: 0 },
      db: null,
      inspectedOrders: orderNbrs.length,
      timing: { erpFetchMs: +(tF2 - tF1).toFixed(1), dbLinesMs: 0, totalMs: +(nowMs() - t0).toFixed(1) },
    };
  }

  const tW1 = nowMs();
  const result = await writeInventoryDetails(baid, rows, { chunkSize: 5000 });
  const tW2 = nowMs();

  return {
    baid,
    erp: { totalFromERP: Array.isArray(rows) ? rows.length : 0 },
    db: result,
    inspectedOrders: orderNbrs.length,
    timing: {
      erpFetchMs: +(tF2 - tF1).toFixed(1),
      dbLinesMs: +(tW2 - tW1).toFixed(1),
      totalMs: +(nowMs() - t0).toFixed(1),
    },
  };
}

export async function ingestInventoryDetails(baid: string) {
  const restService = createAcumaticaService();
  if (!shouldUseQueueErp()) {
    await restService.getToken();
  }
  const result = await handleOne(restService, baid);
  return { count: 1, results: [result] };
}
