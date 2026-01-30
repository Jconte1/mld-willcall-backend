"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchOrderReadyReport = fetchOrderReadyReport;
let loggedKeys = false;
function pickField(row, keys) {
    for (const key of keys) {
        if (key in row && row[key] != null)
            return row[key];
    }
    return null;
}
function parseNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
async function fetchOrderReadyReport() {
    const url = process.env.ACUMATICA_ORDER_READY_ODATA_URL ||
        "https://acumatica.mld.com/OData/MLD/willcall%20100pct";
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
        console.error("[order-ready] odata error", res.status, res.statusText, text.slice(0, 500));
        throw new Error(`Order-ready OData fetch failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json().catch(() => ({}));
    const rows = Array.isArray(json) ? json : Array.isArray(json?.value) ? json.value : [];
    if (!loggedKeys && rows.length) {
        loggedKeys = true;
        console.log("[order-ready] sample fields", Object.keys(rows[0] || {}).slice(0, 50));
    }
    return rows.map((row) => ({
        orderType: pickField(row, ["OrderType", "SOOrder_OrderType", "SOOrder.OrderType"]),
        orderNbr: pickField(row, ["OrderNbr", "SOOrder_OrderNbr", "SOOrder.OrderNbr"]),
        qtyUnallocated: parseNumber(String(pickField(row, ["QtyUnallocated", "willcallNotAllocated_QtyUnallocated"]) ?? "")),
        qtyAllocated: parseNumber(String(pickField(row, ["QtyAllocated", "willcallAllocated_QtyAllocated"]) ?? "")),
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
        warehouse: pickField(row, ["Warehouse", "Warehouse_2", "Warehouse_3", "Warehouse_4"]),
        inventoryId: pickField(row, [
            "InventoryID",
            "InventoryCD",
            "SOLine_InventoryID",
            "SOLine.InventoryID",
            "InventoryItem_InventoryID",
            "INItem_InventoryID",
        ]),
    }));
}
