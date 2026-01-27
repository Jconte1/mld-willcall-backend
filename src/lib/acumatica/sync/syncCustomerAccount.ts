import { createAcumaticaService } from "../createAcumaticaService";
import fetchOrderSummariesSince from "../fetch/fetchOrderSummariesSince";
import fetchAddressContact from "../fetch/fetchAddressContact";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import filterOrders from "../filter/filterOrders";
import { upsertOrderSummariesDelta } from "../write/writeOrderSummaries";
import writeAddressContact from "../write/writeAddressContact";
import writePaymentInfo from "../write/writePaymentInfo";
import writeInventoryDetails from "../write/writeInventoryDetails";
import { denver3amWindowStartLiteral } from "../../time/denver";

const INACTIVE_STATUSES = new Set([
  "Canceled",
  "Cancelled",
  "On Hold",
  "Pending Approval",
  "Rejected",
  "Pending Processing",
  "Awaiting Payment",
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
  details: {
    orderNbrs: number;
    addressRows: number;
    paymentRows: number;
    inventoryRows: number;
  };
};

export async function runCustomerDeltaSync(
  baid: string,
  { sinceLiteral }: { sinceLiteral?: string } = {}
): Promise<SyncResult> {
  const restService = createAcumaticaService();
  await restService.getToken();

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
    details: {
      orderNbrs: activeOrders.length,
      addressRows: Array.isArray(addressRows) ? addressRows.length : 0,
      paymentRows: Array.isArray(paymentRows) ? paymentRows.length : 0,
      inventoryRows: Array.isArray(inventoryRows) ? inventoryRows.length : 0,
    },
  };
}
