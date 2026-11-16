import { prisma } from "../../prisma";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

type AnyRow = Record<string, any>;

export function prepareInventoryDetails(
  baid: string,
  detailRows: AnyRow[],
  requireLineIdentity = false
) {
  const lines: AnyRow[] = [];
  const affectedNbrs = new Set<string>();

  for (const row of Array.isArray(detailRows) ? detailRows : []) {
    const orderNbr = str(val(row, "OrderNbr"));
    if (!orderNbr) continue;

    affectedNbrs.add(orderNbr);

    const details = Array.isArray(row?.Details) ? row.Details : [];
    for (const d of details) {
      const lt = optStr(val(d, "LineType"));
      if (!lt || lt.trim().toLowerCase() !== "goods for inventory") continue;

      const erpId = optStr(val(d, "id")) || optStr(val(d, "LineNbr"));
      if (requireLineIdentity && !erpId) throw new Error(`Missing ERP line identity on ${orderNbr}`);

      const taxZone = pickTaxZone(row, d);
      const taxRate = taxRateFromZone(taxZone);

      // --- Allocation logic (nested under Details -> Allocations) ---
      const allocations = Array.isArray(d?.Allocations) ? d.Allocations : [];

      // isAllocated = TRUE if ANY allocation row has Allocated=true
      const isAllocated =
        allocations.some((a: AnyRow) => Boolean(val(a, "Allocated")) === true) || false;

      // allocatedQty = SUM of Qty where Allocated=true (stored as Int in schema)
      // The cache column is Int; never round up and advertise more than ERP allocated.
      const allocatedQtyRaw = allocations
        .filter((a: AnyRow) => Boolean(val(a, "Allocated")) === true)
        .reduce((sum: number, a: AnyRow) => {
          const q = Number(val(a, "Qty"));
          return sum + (Number.isFinite(q) ? q : 0);
        }, 0);

      const allocatedQty = Number.isFinite(allocatedQtyRaw)
        ? Math.floor(allocatedQtyRaw)
        : 0;

      lines.push({
        id: erpId ? createHash("sha256").update(JSON.stringify([baid.trim(), orderNbr.trim(), erpId])).digest("hex") : randomUUID(),
        orderNbr,
        baid,
        lineDescription: optStr(val(d, "LineDescription")),
        warehouse: optStr(val(d, "WarehouseID")),
        inventoryId: optStr(val(d, "InventoryID")),
        lineType: optStr(val(d, "LineType")),
        openQty: optDec(val(d, "OpenQty"), 4),
        orderQty: optDec(val(d, "OrderQty"), 4),
        amount: optDec(val(d, "Amount"), 2),
        taxRate,
        isAllocated,
        allocatedQty,
        unitPrice: optDec(val(d, "UnitPrice"), 2),
        usrETA: toDate(val(d, "UsrETA")),
        here: optStr(val(d, "Here")),
      });
    }
  }

  const uniqueLines = new Map<string, AnyRow>();
  for (const line of lines) {
    const previous = uniqueLines.get(line.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(line)) {
      throw new Error(`Conflicting ERP rows for the same line on ${line.orderNbr}`);
    }
    uniqueLines.set(line.id, line);
  }
  return { lines: [...uniqueLines.values()], orderNbrs: Array.from(affectedNbrs) };
}

export default async function writeInventoryDetails(
  baid: string,
  detailRows: AnyRow[],
  { chunkSize = 5000, expectedOrderNbrs, client, requireLineIdentity = false }: {
    chunkSize?: number;
    expectedOrderNbrs?: string[];
    client?: Prisma.TransactionClient;
    requireLineIdentity?: boolean;
  } = {}
) {
  const prepared = prepareInventoryDetails(baid, detailRows, requireLineIdentity);
  const lines = prepared.lines;
  const orderNbrList = Array.from(new Set(expectedOrderNbrs ?? prepared.orderNbrs));
  if (prepared.orderNbrs.some((nbr) => !orderNbrList.includes(nbr))) {
    throw new Error("ERP inventory response contains an unexpected order");
  }
  if (!orderNbrList.length) {
    return {
      ordersConsidered: Array.isArray(detailRows) ? detailRows.length : 0,
      ordersAffected: 0,
      linesKept: 0,
      linesDeleted: 0,
      linesInserted: 0,
      scan: {
        ordersScanned: Array.isArray(detailRows) ? detailRows.length : 0,
        ordersWithoutNbr: 0,
        ordersWithNoDetails: 0,
        linesKept: 0,
        linesDroppedEmpty: 0,
      },
    };
  }

  const replace = async (tx: Prisma.TransactionClient) => {
    // Serialize replacement across processes; deletion and insertion must commit together.
    for (const orderNbr of [...orderNbrList].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory:${baid.trim()}:${orderNbr}`}))`;
    }
    const summaries = await tx.erpOrderSummary.findMany({
      where: { baid, orderNbr: { in: orderNbrList } },
      select: { id: true, orderNbr: true },
    });
    const idByNbr = new Map(summaries.map((s) => [s.orderNbr, s.id]));
    if (idByNbr.size !== orderNbrList.length) throw new Error("Missing order summary for inventory replacement");

    const { count: deleted } = await tx.erpOrderLine.deleteMany({
      where: { baid, orderNbr: { in: orderNbrList } },
    });

    let inserted = 0;
    if (lines.length) {
      const mapped = lines
        .map((l) => {
          const orderSummaryId = idByNbr.get(l.orderNbr);
          if (!orderSummaryId) return null;
          return {
            id: l.id,
            orderSummaryId,
            baid: l.baid,
            orderNbr: l.orderNbr,
            lineDescription: l.lineDescription,
            warehouse: l.warehouse,
            inventoryId: l.inventoryId,
            lineType: l.lineType,
            openQty: l.openQty,
            orderQty: l.orderQty,
            amount: l.amount,
            taxRate: l.taxRate,
            isAllocated: l.isAllocated,
            allocatedQty: l.allocatedQty,
            unitPrice: l.unitPrice,
            usrETA: l.usrETA,
            here: l.here,
            updatedAt: new Date(),
          };
        })
        .filter(Boolean) as AnyRow[];

      for (let i = 0; i < mapped.length; i += chunkSize) {
        const slice = mapped.slice(i, i + chunkSize);
        if (!slice.length) continue;
        const { count } = await tx.erpOrderLine.createMany({
          data: slice as any[],
        });
        inserted += count;
      }
    }

    return {
      ordersConsidered: Array.isArray(detailRows) ? detailRows.length : 0,
      ordersAffected: orderNbrList.length,
      linesKept: lines.length,
      linesDeleted: deleted,
      linesInserted: inserted,
      scan: {
        ordersScanned: Array.isArray(detailRows) ? detailRows.length : 0,
        ordersWithoutNbr: 0,
        ordersWithNoDetails: 0,
        linesKept: lines.length,
        linesDroppedEmpty: 0,
      },
    };
  };
  return client ? replace(client) : prisma.$transaction(replace, { timeout: 30000 });
}

// Prefer line-level TaxZone if it exists; fallback to order-level if your payload ends up that way.
function pickTaxZone(orderRow: AnyRow, detailRow: AnyRow) {
  return (
    optStr(val(detailRow, "TaxZone")) ||
    optStr(val(orderRow, "TaxZone")) ||
    optStr(val(orderRow, "TaxZoneID")) ||
    null
  );
}

function taxRateFromZone(zone: string | null) {
  if (!zone) return null;

  const z = zone.trim();

  if (z === "SALT LAKE") return 7.65;
  if (z === "IDAHO") return 6.0;
  if (z === "JACKSON") return 7.0;
  if (z === "CEDAR CITY") return 7.65;
  if (z === "KETCHUM") return 6.0;
  if (z === "PROVO") return 7.65;

  return null;
}

function val(obj: AnyRow, key: string) {
  const v = obj?.[key];
  if (v && typeof v === "object" && "value" in v) return (v as any).value;
  return v;
}

function toDate(v: any) {
  const d = v ? new Date(v) : null;
  return d && !isNaN(+d) ? d : null;
}

function str(v: any) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function optStr(v: any) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }
  if (typeof v === "object") return null;
  const s = String(v).trim();
  return s ? s : null;
}

function optDec(v: any, scale = 2) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Number(n.toFixed(scale));
}
