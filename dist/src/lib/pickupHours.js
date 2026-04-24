"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPickupHours = getPickupHours;
const DEFAULT_HOURS = {
    openHour: 7,
    closeHour: 17,
};
const HOURS_BY_LOCATION = {
    "slc-hq": { openHour: 7, closeHour: 17 },
    "slc-outlet": { openHour: 9, closeHour: 16 },
    "boise-willcall": { openHour: 8, closeHour: 16 },
    "jackson-willcall": { openHour: 9, closeHour: 17 },
    "provo-willcall": { openHour: 9, closeHour: 17 },
};
function getPickupHours(locationId) {
    if (!locationId)
        return DEFAULT_HOURS;
    return HOURS_BY_LOCATION[locationId.toLowerCase()] ?? DEFAULT_HOURS;
}
