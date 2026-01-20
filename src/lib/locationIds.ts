const LEGACY_LOCATION_IDS: Record<string, string[]> = {
  slc: ["slc-hq", "slc-outlet"],
  boise: ["boise-willcall"],
  "boise-will-call": ["boise-willcall"],
};

const CANONICAL_LOCATION_IDS = new Set(["slc-hq", "slc-outlet", "boise-willcall"]);

export function normalizeLocationIds(ids: string[] = []) {
  const normalized = new Set<string>();

  for (const id of ids) {
    const mapped = LEGACY_LOCATION_IDS[id];
    if (mapped?.length) {
      mapped.forEach((value) => normalized.add(value));
    } else {
      normalized.add(id);
    }
  }

  return Array.from(normalized);
}

export function normalizeLocationId(id?: string | null) {
  if (!id) return undefined;
  if (CANONICAL_LOCATION_IDS.has(id)) return id;
  const mapped = LEGACY_LOCATION_IDS[id];
  if (mapped?.length) return mapped[0];
  if (id === "slc") return "slc-hq";
  return id;
}

export function normalizeWarehouseToLocationId(warehouse?: string | null) {
  if (!warehouse) return undefined;
  const normalized = warehouse.trim().replace(/\s+/g, " ").toUpperCase();
  let legacy: string | undefined;

  if (normalized.includes("OUTLET")) legacy = "slc-outlet";
  else if (normalized.includes("BOISE")) legacy = "boise";
  else if (normalized.includes("SALT LAKE") || normalized.includes("SLC")) legacy = "slc";

  // TODO: Add any missing warehouse mappings once identified in Acumatica.
  return normalizeLocationId(legacy ?? normalized);
}

export function expandLocationIds(ids: string[] = []) {
  const expanded = new Set<string>();
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
