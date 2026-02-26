import { createAcumaticaService } from "../createAcumaticaService";
import fetchOrderSummaries from "../fetch/fetchOrderSummaries";
import filterOrders from "../filter/filterOrders";
import { purgeOldOrders, upsertOrderSummariesForBAID } from "../write/writeOrderSummaries";
import { shouldUseQueueErp } from "../../queue/erpClient";

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function handleOne(restService: any, baid: string) {
  const t0 = nowMs();

  const tF1 = nowMs();
  const rawRows = await fetchOrderSummaries(restService, baid);
  const tF2 = nowMs();

  const tS1 = nowMs();
  const { kept, counts, cutoff } = filterOrders(rawRows);
  const tS2 = nowMs();

  const tW1 = nowMs();
  const { inserted, updated, inactivated } = await upsertOrderSummariesForBAID(
    baid,
    kept,
    cutoff,
    { concurrency: 10 }
  );
  const tW2 = nowMs();

  const tP1 = nowMs();
  const purged = await purgeOldOrders(cutoff);
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

export async function ingestOrderSummaries(baid: string) {
  const restService = createAcumaticaService();
  if (!shouldUseQueueErp()) {
    await restService.getToken();
  }
  const result = await handleOne(restService, baid);
  return { count: 1, results: [result] };
}
