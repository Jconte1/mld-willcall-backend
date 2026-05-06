import { createAcumaticaService } from "../createAcumaticaService";
import fetchOrderSummariesSince from "../fetch/fetchOrderSummariesSince";
import fetchAddressContact from "../fetch/fetchAddressContact";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import { queueErpJobRequest, shouldUseQueueErp } from "../../queue/erpClient";
import filterOrders from "../filter/filterOrders";
import { upsertOrderSummariesDelta } from "../write/writeOrderSummaries";
import writeAddressContact from "../write/writeAddressContact";
import writePaymentInfo from "../write/writePaymentInfo";
import writeInventoryDetails from "../write/writeInventoryDetails";
import { denver3amWindowStartLiteral } from "../../time/denver";
import { prisma } from "../../prisma";

const INACTIVE_STATUSES = new Set([
  "Canceled",
  "Cancelled",
  "On Hold",
  "Pending Approval",
  "Rejected",
  "Pending Processing",
  "Credit Hold",
  "Completed",
  "Invoiced",
  "Expired",
  "Purchase Hold",
  "Not Approved",
  "Risk Hold",
]);

type SyncResult = {
  baid: string;
  sinceLiteral: string;
  fetchedHeaders: number;
  keptHeaders: number;
  summary: { inserted: number; updated: number };
  reconciliation: {
    staleCandidates: number;
    verifiedInactive: number;
    verifiedStillActive: number;
    notFound: number;
    verifyFailed: number;
  };
  details: {
    orderNbrs: number;
    addressRows: number;
    paymentRows: number;
    inventoryRows: number;
  };
};

type HeaderLookupResult = {
  found: boolean;
  status: string | null;
};

const DELTA_RECONCILE_MAX_CANDIDATES = Number(
  process.env.CUSTOMER_DELTA_RECONCILE_MAX_CANDIDATES ?? 50
);
const DELTA_RECONCILE_CONCURRENCY = Number(
  process.env.CUSTOMER_DELTA_RECONCILE_CONCURRENCY ?? 5
);

function fieldValue(row: Record<string, any> | null | undefined, key: string) {
  const value = row?.[key];
  if (value && typeof value === "object") {
    if ("value" in value) return (value as { value?: unknown }).value;
    if ("Value" in value) return (value as { Value?: unknown }).Value;
  }
  return value;
}

function normalizeStatus(status: unknown) {
  const raw = String(status ?? "").trim();
  return raw || null;
}

async function fetchOrderHeaderStatus(
  restService: { baseUrl: string; getToken: () => Promise<string> },
  orderNbr: string
): Promise<HeaderLookupResult> {
  if (shouldUseQueueErp()) {
    const resp = await queueErpJobRequest<{ found: boolean; row?: Record<string, any> | null }>(
      "/api/erp/jobs/orders/header",
      { orderNbr }
    );
    const status = normalizeStatus(fieldValue(resp?.row ?? null, "Status"));
    return { found: Boolean(resp?.found), status };
  }

  const token = await restService.getToken();
  const safeOrderNbr = orderNbr.replace(/'/g, "''");
  const params = new URLSearchParams();
  params.set("$filter", `OrderNbr eq '${safeOrderNbr}'`);
  params.set("$select", "OrderNbr,Status,LocationID,ShipVia,CustomerID,LastModified");
  params.set("$top", "1");
  const url = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Order header lookup failed (${response.status}) for ${orderNbr}`);
  }

  const parsed = text ? JSON.parse(text) : [];
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.value) ? parsed.value : [];
  const row = rows[0] ?? null;
  const status = normalizeStatus(fieldValue(row, "Status"));
  return { found: Boolean(row), status };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  if (!items.length) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

export async function runCustomerDeltaSync(
  baid: string,
  { sinceLiteral }: { sinceLiteral?: string } = {}
): Promise<SyncResult> {
  const restService = createAcumaticaService();
  if (!shouldUseQueueErp()) {
    await restService.getToken();
  }

  const since = sinceLiteral ?? denver3amWindowStartLiteral(new Date());
  console.log("[customer-sync][delta] fetch headers", { baid, since });
  const headerRows = await fetchOrderSummariesSince(restService, baid, {
    sinceLiteral: since,
    useOrderBy: true,
  });

  const { kept } = filterOrders(headerRows);
  console.log("[customer-sync][delta] headers", {
    baid,
    fetched: Array.isArray(headerRows) ? headerRows.length : 0,
    kept: kept.length,
  });
  const summary = await upsertOrderSummariesDelta(baid, kept, { concurrency: 10 });
  const seenOrders = new Set(kept.map((row) => String(row.orderNbr || "").trim().toUpperCase()).filter(Boolean));
  const localActive = await prisma.erpOrderSummary.findMany({
    where: { baid, isActive: true },
    select: { orderNbr: true },
    orderBy: [{ updatedAt: "asc" }],
    take: Math.max(1, DELTA_RECONCILE_MAX_CANDIDATES),
  });
  const staleCandidates = localActive
    .map((row) => String(row.orderNbr || "").trim().toUpperCase())
    .filter((orderNbr) => orderNbr && !seenOrders.has(orderNbr));

  const reconcileStats = {
    staleCandidates: staleCandidates.length,
    verifiedInactive: 0,
    verifiedStillActive: 0,
    notFound: 0,
    verifyFailed: 0,
  };

  if (staleCandidates.length) {
    console.log("[customer-sync][delta] reconcile stale active orders", {
      baid,
      staleCandidates: staleCandidates.length,
      maxCandidates: DELTA_RECONCILE_MAX_CANDIDATES,
    });

    await runWithConcurrency(staleCandidates, DELTA_RECONCILE_CONCURRENCY, async (orderNbr) => {
      try {
        const header = await fetchOrderHeaderStatus(restService, orderNbr);
        if (!header.found) {
          reconcileStats.notFound += 1;
          return;
        }

        const status = normalizeStatus(header.status);
        if (status && INACTIVE_STATUSES.has(status)) {
          await prisma.erpOrderSummary.update({
            where: { baid_orderNbr: { baid, orderNbr } },
            data: {
              status,
              isActive: false,
              lastSeenAt: new Date(),
            },
          });
          reconcileStats.verifiedInactive += 1;
          return;
        }

        reconcileStats.verifiedStillActive += 1;
      } catch (err) {
        reconcileStats.verifyFailed += 1;
        console.warn("[customer-sync][delta] stale order verify failed", {
          baid,
          orderNbr,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  const activeOrders = kept
    .filter((row) => !INACTIVE_STATUSES.has(String(row.status || "")))
    .map((row) => row.orderNbr);

  let addressRows: any[] = [];
  let paymentRows: any[] = [];
  let inventoryRows: any[] = [];

  if (activeOrders.length) {
    console.log("[customer-sync][delta] details", {
      baid,
      activeOrders: activeOrders.length,
    });
    [addressRows, paymentRows, inventoryRows] = await Promise.all([
      fetchAddressContact(restService, baid, { orderNbrs: activeOrders }),
      fetchPaymentInfo(restService, baid, { orderNbrs: activeOrders }),
      fetchInventoryDetails(restService, baid, activeOrders),
    ]);

    await writeAddressContact(baid, addressRows);
    await writePaymentInfo(baid, paymentRows);
    await writeInventoryDetails(baid, inventoryRows);
  } else {
    console.log("[customer-sync][delta] skip details (no active orders)", { baid });
  }

  return {
    baid,
    sinceLiteral: since,
    fetchedHeaders: Array.isArray(headerRows) ? headerRows.length : 0,
    keptHeaders: kept.length,
    summary,
    reconciliation: reconcileStats,
    details: {
      orderNbrs: activeOrders.length,
      addressRows: Array.isArray(addressRows) ? addressRows.length : 0,
      paymentRows: Array.isArray(paymentRows) ? paymentRows.length : 0,
      inventoryRows: Array.isArray(inventoryRows) ? inventoryRows.length : 0,
    },
  };
}
