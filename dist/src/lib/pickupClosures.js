"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHolidayClosure = isHolidayClosure;
const ALL_LOCATION_HOLIDAYS = new Set([
    "2026-01-01", // New Year's Day
    "2026-05-25", // Memorial Day
    "2026-07-03", // Independence Day (observed)
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving
    "2026-11-27", // Day after Thanksgiving
    "2026-12-25", // Christmas Day
]);
const LOCATION_HOLIDAYS = {
    "slc-hq": new Set(["2026-07-24"]), // Pioneer Day
    "slc-outlet": new Set(["2026-07-24"]), // Pioneer Day
    "provo-willcall": new Set(["2026-07-24"]), // Pioneer Day
};
function isHolidayClosure(dateStr, locationId) {
    if (ALL_LOCATION_HOLIDAYS.has(dateStr))
        return true;
    if (!locationId)
        return false;
    const perLocation = LOCATION_HOLIDAYS[locationId.toLowerCase()];
    return perLocation ? perLocation.has(dateStr) : false;
}
