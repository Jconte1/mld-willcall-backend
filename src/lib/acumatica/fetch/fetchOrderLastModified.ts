import { createAcumaticaService } from "../createAcumaticaService";
import { queueErpRequest, shouldUseQueueErp } from "../../queue/erpClient";
import type { QueueOrderLastModifiedResponse } from "../../queue/contracts";

type AnyRow = Record<string, any>;

function normalizeRowArray(text: string) {
  const arr = text ? JSON.parse(text) : [];
  return Array.isArray(arr) ? arr : Array.isArray((arr as any)?.value) ? (arr as any).value : [];
}

export async function fetchOrderLastModified(
  baid: string,
  orderNbr: string,
  restService?: { baseUrl: string; getToken: () => Promise<string> }
) {
  if (shouldUseQueueErp()) {
    const params = new URLSearchParams({ baid, orderNbr });
    const resp = await queueErpRequest<QueueOrderLastModifiedResponse>(
      `/api/erp/orders/last-modified?${params.toString()}`
    );
    const raw = resp?.lastModified ?? null;
    const parsed = raw ? new Date(raw) : null;
    return { lastModified: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null, raw };
  }

  const service = restService ?? createAcumaticaService();
  const token = await service.getToken();

  const base = `${service.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
  const params = new URLSearchParams();
  const safeOrderNbr = String(orderNbr).replace(/'/g, "''");
  const safeBaid = String(baid).replace(/'/g, "''");
  params.set(
    "$filter",
    [`OrderNbr eq '${safeOrderNbr}'`, `CustomerID eq '${safeBaid}'`].join(" and ")
  );
  params.set("$select", ["OrderNbr", "LastModified"].join(","));
  params.set("$top", "1");
  const url = `${base}?${params.toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || `ERP error for ${orderNbr}`);

  let rows: AnyRow[] = [];
  try {
    rows = normalizeRowArray(text);
  } catch {
    rows = [];
  }

  const row = rows[0] || null;
  const raw =
    row?.LastModified?.value ??
    row?.lastModified?.value ??
    row?.LastModified ??
    row?.lastModified ??
    null;
  if (!raw) {
    console.log("[order-ready] last-modified raw", { orderNbr, baid, raw: null });
    return { lastModified: null, raw: null };
  }
  const parsed = new Date(raw);
  console.log("[order-ready] last-modified raw", { orderNbr, baid, raw });
  return { lastModified: Number.isNaN(parsed.getTime()) ? null : parsed, raw };
}