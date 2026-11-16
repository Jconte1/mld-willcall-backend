import { randomUUID } from "node:crypto";
import { prisma } from "../../prisma";
import { queueErpJobRequest, shouldUseQueueErp } from "../../queue/erpClient";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import writeInventoryDetails, { prepareInventoryDetails } from "../write/writeInventoryDetails";

type Row = Record<string, any>;
const ELIGIBLE_STATUSES = new Set(["open", "shipping", "back order", "backorder", "on hold but approved"]);

export class PickupOrderVerificationError extends Error {
  constructor(message: string, public code = "ERP_VERIFICATION_FAILED", public statusCode = 503) {
    super(message);
    this.name = "PickupOrderVerificationError";
  }
}

function value(row: Row, key: string): any {
  const v = row?.[key];
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

function text(row: Row, key: string) { return String(value(row, key) ?? "").trim(); }

function number(row: Row, key: string) {
  const v = value(row, key);
  if ((typeof v !== "number" && typeof v !== "string") ||
    (typeof v === "string" && !v.trim()) || !Number.isFinite(Number(v))) {
    throw new Error(`Missing or invalid ${key}`);
  }
  return Number(v);
}

function requireEligible(orderNbr: string, status: string) {
  if (!ELIGIBLE_STATUSES.has(status.trim().toLowerCase())) {
    throw new PickupOrderVerificationError(
      `Order ${orderNbr} cannot be scheduled: Acumatica status is ${status || "unavailable"}.`,
      "ORDER_NOT_ELIGIBLE", 409
    );
  }
}

export async function readPickupOrderHeader(orderNbr: string): Promise<Row | null> {
  if (shouldUseQueueErp()) {
    const result = await queueErpJobRequest<{ found: boolean; row?: Row }>("/api/erp/jobs/orders/header", { orderNbr });
    if (result?.found === false && !result.row) return null;
    if (result?.found !== true || !result.row) throw new Error("Invalid ERP header response");
    return result.row;
  }
  const service = createAcumaticaService();
  const token = await service.getToken();
  const params = new URLSearchParams({
    "$filter": `OrderNbr eq '${orderNbr.replace(/'/g, "''")}'`,
    "$select": "OrderNbr,Status,CustomerID,LocationID,ShipVia,LastModified", "$top": "2",
  });
  const response = await fetch(`${service.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder?${params}`, {
    method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`ERP header request failed (${response.status})`);
  const data = await response.json();
  const rows = Array.isArray(data) ? data : Array.isArray(data?.value) ? data.value : null;
  if (!rows || rows.length > 1) throw new Error("Invalid or ambiguous ERP header response");
  return rows[0] ?? null;
}

// Fetch and validate before writing. Never authorize a new booking from a cached order.
export async function refreshVerifiedPickupOrder(orderNbrInput: string) {
  const orderNbr = orderNbrInput.trim().toUpperCase();
  const startedAt = Date.now();
  try {
    const header = await readPickupOrderHeader(orderNbr);
    if (!header) return null;
    if (text(header, "OrderNbr") !== orderNbr || !text(header, "CustomerID") || !text(header, "Status")) {
      throw new Error("ERP header does not identify the requested order");
    }
    const status = text(header, "Status");
    requireEligible(orderNbr, status);
    const baid = text(header, "CustomerID");
    const service = createAcumaticaService();
    const [paymentRows, detailRows] = await Promise.all([
      fetchPaymentInfo(service, baid, { orderNbrs: [orderNbr] }),
      fetchInventoryDetails(service, baid, [orderNbr]),
    ]);
    if (paymentRows.length !== 1 || text(paymentRows[0], "OrderNbr") !== orderNbr) {
      throw new Error("ERP payment response did not verify the requested order");
    }
    const payment = paymentRows[0];
    if (!text(payment, "Status")) throw new Error("ERP payment status is missing");
    if (text(payment, "CustomerID") && text(payment, "CustomerID") !== baid) throw new Error("ERP payment customer mismatch");
    requireEligible(orderNbr, text(payment, "Status"));
    if (text(payment, "Status").toLowerCase() !== status.toLowerCase()) {
      throw new Error("Order status changed during verification; retry the lookup");
    }
    const orderTotal = number(payment, "OrderTotal");
    const unpaidBalance = number(payment, "UnpaidBalance");
    const terms = text(payment, "Terms");
    if (!terms) throw new Error("ERP payment terms are missing");
    if (detailRows.length !== 1 || text(detailRows[0], "OrderNbr") !== orderNbr || !Array.isArray(detailRows[0].Details)) {
      throw new Error("ERP returned no verifiable inventory snapshot; cached items cannot be used");
    }
    if (text(detailRows[0], "CustomerID") && text(detailRows[0], "CustomerID") !== baid) throw new Error("ERP inventory customer mismatch");
    for (const line of detailRows[0].Details) {
      if (text(line, "LineType").toLowerCase() !== "goods for inventory") continue;
      for (const key of ["OpenQty", "OrderQty", "Amount"]) number(line, key);
      if (!text(line, "InventoryID") || !Array.isArray(line.Allocations)) throw new Error("Incomplete ERP inventory line");
      for (const allocation of line.Allocations) {
        if (typeof value(allocation, "Allocated") !== "boolean") throw new Error("Invalid ERP allocation flag");
        number(allocation, "Qty");
      }
    }
    const prepared = prepareInventoryDetails(baid, detailRows, true);
    if (!prepared.lines.some((line) => line.openQty > 0 && line.isAllocated && line.allocatedQty > 0)) {
      throw new PickupOrderVerificationError(`Order ${orderNbr} has no open, allocated items available for pickup.`, "NO_PICKUP_ITEMS", 409);
    }
    const verifiedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory:${baid}:${orderNbr}`}))`;
      const locationId = text(header, "LocationID") || null;
      const shipVia = text(header, "ShipVia") || null;
      const lastModified = text(header, "LastModified");
      const lastAcumaticaModifiedAt = lastModified && Number.isFinite(Date.parse(lastModified)) ? new Date(lastModified) : null;
      const summary = await tx.erpOrderSummary.upsert({
        where: { baid_orderNbr: { baid, orderNbr } },
        create: { id: randomUUID(), baid, orderNbr, status, locationId, shipVia, updatedAt: verifiedAt,
          lastSeenAt: verifiedAt, lastAcumaticaPullAt: verifiedAt, lastAcumaticaModifiedAt, isActive: true },
        update: { status, locationId, shipVia, updatedAt: verifiedAt, lastSeenAt: verifiedAt,
          lastAcumaticaPullAt: verifiedAt, lastAcumaticaModifiedAt, isActive: true },
      });
      const data = { baid, orderNbr, status, terms, orderTotal, unpaidBalance, updatedAt: verifiedAt };
      await tx.erpOrderPayment.upsert({
        where: { orderSummaryId: summary.id },
        create: { id: randomUUID(), orderSummaryId: summary.id, ...data }, update: data,
      });
      await writeInventoryDetails(baid, detailRows, { client: tx, expectedOrderNbrs: [orderNbr], requireLineIdentity: true });
      return tx.erpOrderSummary.findUniqueOrThrow({
        where: { id: summary.id },
        select: {
          orderNbr: true, baid: true, status: true, shipVia: true, salesPersonNumber: true,
          ErpOrderPayment: { select: { status: true, terms: true, orderTotal: true, unpaidBalance: true, otherFees: true } },
          ErpOrderLine: { select: { id: true, inventoryId: true, lineDescription: true, warehouse: true,
            openQty: true, orderQty: true, allocatedQty: true, isAllocated: true, amount: true, taxRate: true } },
        },
      });
    }, { timeout: 30000 });
    console.info("[pickup-orders][verify] fresh snapshot committed", {
      orderNbr, status, lineCount: result.ErpOrderLine.length, verifiedAt: verifiedAt.toISOString(), durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    console.warn("[pickup-orders][verify] rejected", { orderNbr, durationMs: Date.now() - startedAt,
      code: error instanceof PickupOrderVerificationError ? error.code : "ERP_VERIFICATION_FAILED",
      reason: error instanceof Error ? error.message : String(error) });
    if (error instanceof PickupOrderVerificationError) throw error;
    throw new PickupOrderVerificationError(`Could not verify current Acumatica data for ${orderNbr}. No cached items were used. Please retry.`);
  }
}
