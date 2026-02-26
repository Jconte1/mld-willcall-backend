import { queueErpJobRequest, shouldUseQueueErp } from "../../queue/erpClient";
import type { QueueRowsResponse } from "../../queue/contracts";

export type OrderReadyRow = {
  orderType: string | null;
  orderNbr: string | null;
  qtyUnallocated: number | null;
  qtyAllocated: number | null;
  shipVia: string | null;
  status: string | null;
  customerId: string | null;
  attributeBuyerGroup: string | null;
  customerLocationId: string | null;
  attributeOsContact: string | null;
  attributeSiteNumber: string | null;
  attributeDelEmail: string | null;
  attributeSmsTxt: string | null;
  attributeEmailNoty: string | null;
  attributeSmsOptIn: boolean | null;
  attributeEmailOptIn: boolean | null;
  warehouse: string | null;
  inventoryId: string | null;
};

let loggedKeys = false;

function pickField(row: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (key in row && row[key] != null) return row[key];
  }
  return null;
}

function pickCanonicalField(row: Record<string, any>, key: string) {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

function parseNumber(value: string) {
  const raw = unwrapValue(value);
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function unwrapValue(value: any) {
  if (value == null) return null;
  if (typeof value === "object") {
    if ("value" in value) return (value as { value?: unknown }).value ?? null;
    if ("Value" in value) return (value as { Value?: unknown }).Value ?? null;
    if ("#text" in value) return (value as { "#text"?: unknown })["#text"] ?? null;
  }
  return value;
}

function parseBoolean(value: any) {
  const raw = unwrapValue(value);
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

async function fetchRawRows() {
  if (shouldUseQueueErp()) {
    const resp = await queueErpJobRequest<QueueRowsResponse<Record<string, any>>>(
      "/api/erp/jobs/reports/order-ready",
      {}
    );
    return Array.isArray(resp?.rows) ? resp.rows : [];
  }

  const url =
    process.env.ACUMATICA_ORDER_READY_ODATA_URL ||
    "https://acumatica.mld.com/OData/MLD/Ready%20for%20Willcall";
  const username = process.env.ACUMATICA_USERNAME;
  const password = process.env.ACUMATICA_PASSWORD;

  if (!username || !password) {
    throw new Error("Missing ACUMATICA_USERNAME or ACUMATICA_PASSWORD env vars");
  }

  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "[order-ready] odata error",
      res.status,
      res.statusText,
      text.slice(0, 500)
    );
    throw new Error(`Order-ready OData fetch failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  return Array.isArray(json) ? json : Array.isArray(json?.value) ? json.value : [];
}

export async function fetchOrderReadyReport() {
  const rows = await fetchRawRows();
  if (!loggedKeys && rows.length) {
    loggedKeys = true;
    console.log("[order-ready] sample fields", Object.keys(rows[0] || {}).slice(0, 50));
  }
  return rows.map((row: Record<string, any>): OrderReadyRow => ({
    ...(function () {
      const orderNbr = pickField(row, ["OrderNbr", "SOOrder_OrderNbr", "SOOrder.OrderNbr"]);
      const smsOptInRaw = pickCanonicalField(row, "SMSOptin");
      const emailOptInRaw = pickCanonicalField(row, "EmailOptin");
      const smsOptInParsed = parseBoolean(smsOptInRaw);
      const emailOptInParsed = parseBoolean(emailOptInRaw);

      if (smsOptInRaw === undefined || emailOptInRaw === undefined) {
        const optInKeys = Object.keys(row).filter((k) => k.toLowerCase().includes("optin"));
        console.error("[order-ready] opt-in fetch shape mismatch", {
          orderNbr,
          expectedKeys: ["SMSOptin", "EmailOptin"],
          foundOptInKeys: optInKeys,
          smsOptInRaw,
          emailOptInRaw,
        });
      }

      if (smsOptInParsed == null || emailOptInParsed == null) {
        console.warn("[order-ready] opt-in parse mismatch", {
          orderNbr,
          smsOptInRaw,
          emailOptInRaw,
          smsOptInParsed,
          emailOptInParsed,
        });
      }

      return {
    orderType: pickField(row, ["OrderType", "SOOrder_OrderType", "SOOrder.OrderType"]),
    orderNbr: pickField(row, ["OrderNbr", "SOOrder_OrderNbr", "SOOrder.OrderNbr"]),
    qtyUnallocated: parseNumber(
      String(pickField(row, ["QtyUnallocated", "willcallNotAllocated_QtyUnallocated"]) ?? "")
    ),
    qtyAllocated: parseNumber(
      String(pickField(row, ["QtyAllocated", "willcallAllocated_QtyAllocated"]) ?? "")
    ),
    shipVia: pickField(row, ["ShipVia", "SOOrder_ShipVia", "SOOrder.ShipVia"]),
    status: pickField(row, ["Status", "SOOrder_Status", "SOOrder.Status"]),
    customerId: pickField(row, [
      "Customer",
      "CustomerID",
      "SOOrder_CustomerID",
      "SOOrder.CustomerID",
    ]),
    attributeBuyerGroup: pickField(row, [
      "BuyerGroup",
      "AttributeBUYERGROUP",
      "SOOrder_AttributeBUYERGROUP",
      "SOOrder.AttributeBUYERGROUP",
    ]),
    customerLocationId: pickField(row, [
      "Location",
      "CustomerLocationID",
      "SOOrder_CustomerLocationID",
      "SOOrder.CustomerLocationID",
    ]),
    attributeOsContact: pickField(row, ["DeliveryContact", "AttributeOSCONTACT", "SOOrder_AttributeOSCONTACT"]),
    attributeSiteNumber: pickField(row, [
      "DeliveryContactNumber",
      "AttributeSITENUMBER",
      "SOOrder_AttributeSITENUMBER",
    ]),
    attributeDelEmail: pickField(row, [
      "DeliveryEmail",
      "AttributeDELEMAIL",
      "SOOrder_AttributeDELEMAIL",
    ]),
    attributeSmsTxt: pickField(row, [
      "TextNotification",
      "AttributeSMSTXT",
      "SOOrder_AttributeSMSTXT",
      "SOOrder.AttributeSMSTXT",
    ]),
    attributeEmailNoty: pickField(row, [
      "EmailNotification",
      "AttributeEMAILNOTY",
      "SOOrder_AttributeEMAILNOTY",
      "SOOrder.AttributeEMAILNOTY",
    ]),
    attributeSmsOptIn: smsOptInParsed,
    attributeEmailOptIn: emailOptInParsed,
    warehouse: pickField(row, ["Warehouse", "Warehouse_2", "Warehouse_3", "Warehouse_4"]),
    inventoryId: pickField(row, [
      "InventoryID",
      "InventoryCD",
      "SOLine_InventoryID",
      "SOLine.InventoryID",
      "InventoryItem_InventoryID",
      "INItem_InventoryID",
    ]),
      };
    })(),
  }));
}
