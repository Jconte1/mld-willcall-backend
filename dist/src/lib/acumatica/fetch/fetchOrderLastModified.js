"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchOrderLastModified = fetchOrderLastModified;
const createAcumaticaService_1 = require("../createAcumaticaService");
function normalizeRowArray(text) {
    const arr = text ? JSON.parse(text) : [];
    return Array.isArray(arr) ? arr : Array.isArray(arr?.value) ? arr.value : [];
}
async function fetchOrderLastModified(baid, orderNbr, restService) {
    const service = restService ?? (0, createAcumaticaService_1.createAcumaticaService)();
    const token = await service.getToken();
    const base = `${service.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
    const params = new URLSearchParams();
    const safeOrderNbr = String(orderNbr).replace(/'/g, "''");
    const safeBaid = String(baid).replace(/'/g, "''");
    params.set("$filter", [`OrderNbr eq '${safeOrderNbr}'`, `CustomerID eq '${safeBaid}'`].join(" and "));
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
    if (!resp.ok)
        throw new Error(text || `ERP error for ${orderNbr}`);
    let rows = [];
    try {
        rows = normalizeRowArray(text);
    }
    catch {
        rows = [];
    }
    const row = rows[0] || null;
    const raw = row?.LastModified?.value ??
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
