const CANONICAL_PICKUP_LOCATION_IDS = new Set([
  "slc-hq",
  "slc-outlet",
  "boise-willcall",
  "jackson-willcall",
  "provo-willcall",
]);

function normalizeText(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function resolveOrderReadyJobDisplay(input: { locationId?: string | null; jobName?: string | null }) {
  const locationId = normalizeText(input.locationId);
  const jobName = normalizeText(input.jobName);

  if (!locationId && !jobName) return null;

  if (locationId && CANONICAL_PICKUP_LOCATION_IDS.has(locationId)) {
    return jobName ?? null;
  }

  return jobName ?? locationId;
}
