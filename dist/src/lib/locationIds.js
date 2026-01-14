"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLocationIds = normalizeLocationIds;
exports.normalizeLocationId = normalizeLocationId;
exports.expandLocationIds = expandLocationIds;
const LEGACY_LOCATION_IDS = {
    slc: ["slc-hq", "slc-outlet"],
    boise: ["boise-willcall"],
    "boise-will-call": ["boise-willcall"],
};
const CANONICAL_LOCATION_IDS = new Set(["slc-hq", "slc-outlet", "boise-willcall"]);
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
