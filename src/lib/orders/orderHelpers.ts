type LineStats = {
  totalLines: number;
  openLines: number;
  closedLines: number;
};

const CANCELLED = new Set(["Cancelled", "Canceled"]);
const HOLD = new Set(["On Hold", "Credit Hold", "Purchase Hold", "Risk Hold"]);
const COMPLETE = new Set(["Completed", "Invoiced"]);

export function toNumber(value: any) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function inferOrderType(summary: {
  buyerGroup: string | null;
  jobName: string | null;
  shipVia: string | null;
}) {
  const hay = [summary.buyerGroup, summary.jobName, summary.shipVia]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (hay.includes("plumb")) return "Plumbing";
  if (hay.includes("hard")) return "Hardware";
  if (hay.includes("appliance") || hay.includes("appl")) return "Appliance";
  if (hay.includes("electrical")) return "Electrical";
  return summary.buyerGroup || summary.shipVia || "General";
}

export function inferFulfillmentStatus(erpStatus: string, lineSummary: LineStats) {
  if (CANCELLED.has(erpStatus)) return "Cancelled";
  if (HOLD.has(erpStatus)) return "On Hold";
  if (COMPLETE.has(erpStatus)) return "Complete";

  if (lineSummary.totalLines > 0) {
    if (lineSummary.openLines === 0) return "Complete";
    if (lineSummary.openLines < lineSummary.totalLines) return "Partially Complete";
    return "Pending";
  }

  return "Processing";
}

export function inferPaymentStatus(
  unpaidBalance: number | null | undefined,
  terms: string | null | undefined,
  status: string | null | undefined
) {
  if (unpaidBalance == null || unpaidBalance <= 0) return null;
  const normalizedTerms = (terms ?? "").trim().toUpperCase();
  const TERMS_CUSTOMERS = new Set([
    "N30DEP",
    "N30LDEP",
    "N30LNDEP",
    "N30MULTI",
    "N30NODEP",
    "N60NODEP",
    "NET 30",
    "2P10 N30",
  ]);
  const PREPAY_CUSTOMERS = new Set(["PP", "PPP", "PPT", "TRADE", "CONTRACT"]);

  if (PREPAY_CUSTOMERS.has(normalizedTerms)) return "Balance Due";
  if (TERMS_CUSTOMERS.has(normalizedTerms)) return null;
  return "Balance Due";
}
