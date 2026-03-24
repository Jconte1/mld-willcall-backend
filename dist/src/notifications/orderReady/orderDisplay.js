"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveOrderReadyJobDisplay = resolveOrderReadyJobDisplay;
const CANONICAL_PICKUP_LOCATION_IDS = new Set([
    "slc-hq",
    "slc-outlet",
    "boise-willcall",
    "jackson-willcall",
    "provo-willcall",
]);
function normalizeText(value) {
    const normalized = String(value ?? "").trim();
    return normalized || null;
}
function resolveOrderReadyJobDisplay(input) {
    const locationId = normalizeText(input.locationId);
    const jobName = normalizeText(input.jobName);
    if (!locationId && !jobName)
        return null;
    if (locationId && CANONICAL_PICKUP_LOCATION_IDS.has(locationId)) {
        return jobName ?? null;
    }
    return jobName ?? locationId;
}
