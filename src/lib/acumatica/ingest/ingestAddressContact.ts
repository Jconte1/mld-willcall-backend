import { PrismaClient } from "@prisma/client";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchAddressContact from "../fetch/fetchAddressContact";
import writeAddressContact from "../write/writeAddressContact";
import { oneYearAgoDenver, toDenverDateTimeOffsetLiteral } from "../../time/denver";

const prisma = new PrismaClient();

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function handleOne(restService: any, baid: string) {
  const t0 = nowMs();

  const cutoffDenver = oneYearAgoDenver(new Date());
  const cutoffLiteral = toDenverDateTimeOffsetLiteral(cutoffDenver);

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
  const rows = await fetchAddressContact(restService, baid, {
    orderNbrs,
    cutoffLiteral,
  });
  const tF2 = nowMs();

  const tW1 = nowMs();
  const result = await writeAddressContact(baid, rows, { concurrency: 10 });
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

export async function ingestAddressContact(baid: string) {
  const restService = createAcumaticaService();
  await restService.getToken();
  const result = await handleOne(restService, baid);
  return { count: 1, results: [result] };
}
