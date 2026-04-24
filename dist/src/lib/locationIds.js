"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLocationIds = normalizeLocationIds;
exports.normalizeLocationId = normalizeLocationId;
exports.normalizeWarehouseToLocationId = normalizeWarehouseToLocationId;
exports.expandLocationIds = expandLocationIds;
const LEGACY_LOCATION_IDS = {
    slc: ["slc-hq", "slc-outlet"],
    boise: ["boise-willcall"],
    "boise-will-call": ["boise-willcall"],
};
const CANONICAL_LOCATION_IDS = new Set([
    "slc-hq",
    "slc-outlet",
    "boise-willcall",
    "jackson-willcall",
    "provo-willcall",
]);
const SLC_HQ_WAREHOUSES = new Set([
    "SALT LAKE APPLIANCES",
    "SALT LAKE HARDWARE",
    "SALT LAKE PLUMBING",
    "SALT LAKE INSTALL",
]);
const SLC_OUTLET_WAREHOUSES = new Set([
    "ROTH CONSIGNMENT",
    "SALT LAKE SHOWROOM",
    "SALT LAKE CLOSEOUT",
]);
const BOISE_WAREHOUSES = new Set([
    "BOISE SHOWROOM",
    "BOISE WAREHOUSE",
]);
const JACKSON_WAREHOUSES = new Set(["JACKSON SHOWROOM"]);
const PROVO_WAREHOUSES = new Set(["PROVO SHOWROOM"]);
function normalizeLocationIds(ids = []) {
    const normalized = new Set();
    for (const id of ids) {
        const mapped = LEGACY_LOCATION_IDS[id];
        if (mapped?.length) {
            mapped.forEach((value) => normalized.add(value));
        }
        else {
            normalized.add(id);
        }
    }
    return Array.from(normalized);
}
function normalizeLocationId(id) {
    if (!id)
        return undefined;
    if (CANONICAL_LOCATION_IDS.has(id))
        return id;
    const mapped = LEGACY_LOCATION_IDS[id];
    if (mapped?.length)
        return mapped[0];
    if (id === "slc")
        return "slc-hq";
    return id;
}
function normalizeWarehouseToLocationId(warehouse) {
    if (!warehouse)
        return undefined;
    const normalized = warehouse.trim().replace(/\s+/g, " ").toUpperCase();
    let canonical;
    if (SLC_HQ_WAREHOUSES.has(normalized))
        canonical = "slc-hq";
    else if (SLC_OUTLET_WAREHOUSES.has(normalized))
        canonical = "slc-outlet";
    else if (BOISE_WAREHOUSES.has(normalized))
        canonical = "boise-willcall";
    else if (JACKSON_WAREHOUSES.has(normalized))
        canonical = "jackson-willcall";
    else if (PROVO_WAREHOUSES.has(normalized))
        canonical = "provo-willcall";
    // Acumatica has multiple "location" concepts: warehouse text (pickup context) vs SalesOrder LocationID
    // (often job/site/customer context like MAIN, LOT 20, etc.). This function must only translate warehouse
    // labels to pickup-site IDs. If new warehouse labels appear in ERP logs, add explicit mappings here rather
    // than letting raw values propagate into downstream pickup location fields.
    return canonical ? normalizeLocationId(canonical) : undefined;
}
function expandLocationIds(ids = []) {
    const expanded = new Set();
    const normalized = normalizeLocationIds(ids);
    normalized.forEach((id) => {
        expanded.add(id);
        if (id === "slc-hq" || id === "slc-outlet") {
            expanded.add("slc");
        }
        if (id === "boise-willcall") {
            expanded.add("boise");
            expanded.add("boise-will-call");
        }
    });
    return Array.from(expanded);
}
