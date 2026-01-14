import { ingestOrderSummaries } from "./ingest/ingestOrderSummaries";
import { ingestPaymentInfo } from "./ingest/ingestPaymentInfo";
import { ingestInventoryDetails } from "./ingest/ingestInventoryDetails";
import { ingestAddressContact } from "./ingest/ingestAddressContact";

export type OneTimeSyncKey =
  | "order-summaries"
  | "payment-info"
  | "inventory-details"
  | "address-contact";

const DEFAULT_RUN: OneTimeSyncKey[] = [
  "order-summaries",
  "payment-info",
  "inventory-details",
  "address-contact",
];

const runners: Record<OneTimeSyncKey, (baid: string) => Promise<any>> = {
  "order-summaries": ingestOrderSummaries,
  "payment-info": ingestPaymentInfo,
  "inventory-details": ingestInventoryDetails,
  "address-contact": ingestAddressContact,
};

type OneTimeSyncInput = {
  userId?: string | null;
  email?: string | null;
  baid: string;
  run?: OneTimeSyncKey[];
};

export async function runOneTimeSync(input: OneTimeSyncInput) {
  const run = Array.isArray(input.run) && input.run.length ? input.run : DEFAULT_RUN;
  const tasks = run.filter((k) => runners[k]);

  const results: Array<{
    route: OneTimeSyncKey;
    status: number;
    ok: boolean;
    body: any;
  }> = [];

  for (const key of tasks) {
    try {
      const body = await runners[key](input.baid);
      results.push({ route: key, status: 200, ok: true, body });
    } catch (err: any) {
      results.push({
        route: key,
        status: 500,
        ok: false,
        body: { message: String(err?.message || err) },
      });
    }
  }

  return { count: results.length, results };
}
