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
  customerIdDescription: string | null;
  salspersonnumber: string | null;
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

function parseBoolean(value: unknown, field: string, rowIndex: number): boolean | null {
  const raw = unwrapValue(value);
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`Order-ready consent validation failed: unrecognized ${field} value at row ${rowIndex + 1}.`);
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (["true", "1", "yes", "y", "opt-in", "opt in", "optin"].includes(s)) return true;
  if (["false", "0", "no", "n", "opt-out", "opt out", "optout"].includes(s)) return false;
  throw new Error(`Order-ready consent validation failed: unrecognized ${field} value at row ${rowIndex + 1}.`);
}

async function fetchRawRows() {
  if (shouldUseQueueErp()) {
    const resp = await queueErpJobRequest<QueueRowsResponse<Record<string, any>>>(
      "/api/erp/jobs/reports/order-ready",
      {}
    );
    if (!Array.isArray(resp?.rows)) {
      throw new Error("Order-ready report validation failed: queue response must contain a rows array.");
    }
    return resp.rows;
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

  const json = await res.json();
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.value)) return json.value;
  throw new Error("Order-ready report validation failed: OData response must be an array or contain a value array.");
}

export async function fetchOrderReadyReport() {
  const rows = await fetchRawRows();
  if (!loggedKeys && rows.length) {
    loggedKeys = true;
    console.log("[order-ready] sample fields", Object.keys(rows[0] || {}).slice(0, 50));
  }
  // Validate the entire batch before returning anything to the sync's write/send loop.
  const mappedRows: OrderReadyRow[] = rows.map((row: Record<string, any>, rowIndex: number): OrderReadyRow => ({
    ...(function () {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Order-ready report validation failed: row ${rowIndex + 1} must be an object.`);
      }
      const smsOptInRaw = pickCanonicalField(row, "SMSOptin");
      const emailOptInRaw = pickCanonicalField(row, "EmailOptin");

      if (smsOptInRaw === undefined || emailOptInRaw === undefined) {
        const missing = [smsOptInRaw === undefined ? "SMSOptin" : null, emailOptInRaw === undefined ? "EmailOptin" : null].filter(Boolean);
        throw new Error(`Order-ready consent validation failed: missing ${missing.join(", ")} at row ${rowIndex + 1}.`);
      }
      const smsOptInParsed = parseBoolean(smsOptInRaw, "SMSOptin", rowIndex);
      const emailOptInParsed = parseBoolean(emailOptInRaw, "EmailOptin", rowIndex);

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
    customerIdDescription: pickField(row, [
      "CustomerID_Description",
      "Customer_Description",
      "CustomerDescription",
      "CustomerName",
      "SOOrder_CustomerName",
      "SOOrder.CustomerName",
    ]),
    salspersonnumber: pickField(row, [
      "AttributeSALESNEW",
      "AttributeSALES1",
      "SOOrder_AttributeSALESNEW",
      "SOOrder.AttributeSALESNEW",
      "Salesperson1",
      "SalespersonID",
      "SalespersonID_2",
      "SalespersonID_3",
      "DefaultSalesperson",
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

  const consentCounts = (field: "attributeSmsOptIn" | "attributeEmailOptIn") =>
    mappedRows.reduce((counts, row) => {
      const key = row[field] === true ? "optedIn" : row[field] === false ? "optedOut" : "unset";
      counts[key] += 1;
      return counts;
    }, { optedIn: 0, optedOut: 0, unset: 0 });
  console.info("[order-ready] consent validation passed", {
    rows: mappedRows.length,
    sms: consentCounts("attributeSmsOptIn"),
    email: consentCounts("attributeEmailOptIn"),
  });
  return mappedRows;
}
