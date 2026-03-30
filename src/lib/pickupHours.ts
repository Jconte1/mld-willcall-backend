type PickupHours = {
  openHour: number;
  closeHour: number;
};

const DEFAULT_HOURS: PickupHours = {
  openHour: 7,
  closeHour: 17,
};

const HOURS_BY_LOCATION: Record<string, PickupHours> = {
  "slc-hq": { openHour: 7, closeHour: 17 },
  "slc-outlet": { openHour: 9, closeHour: 16 },
  "boise-willcall": { openHour: 8, closeHour: 16 },
  "jackson-willcall": { openHour: 9, closeHour: 17 },
  "provo-willcall": { openHour: 9, closeHour: 17 },
};

export function getPickupHours(locationId: string | null | undefined): PickupHours {
  if (!locationId) return DEFAULT_HOURS;
  return HOURS_BY_LOCATION[locationId.toLowerCase()] ?? DEFAULT_HOURS;
}

