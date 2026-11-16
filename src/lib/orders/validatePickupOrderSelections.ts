import { PickupOrderVerificationError } from "../acumatica/ingest/refreshVerifiedPickupOrder";

type Selection = { orderNbr: string; items: { lineId?: string; inventoryId: string; qty: number }[] };
type Detail = { orderNbr: string; lines: { id: string; inventoryId: string | null; openQty: number; allocatedQty: number; isAllocated: boolean }[] };

export function validatePickupOrderSelections(details: Detail[], selections: Selection[]) {
  const totals = new Map<string, number>();
  for (const selection of selections) {
    const detail = details.find((entry) => entry.orderNbr === selection.orderNbr);
    if (!detail) throw new PickupOrderVerificationError(`Order ${selection.orderNbr} was not verified.`, "ORDER_UNVERIFIED", 409);
    for (const item of selection.items) {
      let matches = item.lineId
        ? detail.lines.filter((line) => line.id === item.lineId && line.inventoryId === item.inventoryId)
        : detail.lines.filter((line) => line.inventoryId === item.inventoryId);
      // Old caches used random UUIDs. Migrate only an unambiguous model, using fresh ERP limits.
      if (!matches.length && item.lineId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.lineId)) {
        matches = detail.lines.filter((line) => line.inventoryId === item.inventoryId);
      }
      if (matches.length !== 1) {
        throw new PickupOrderVerificationError(
          `Item ${item.inventoryId} on ${selection.orderNbr} changed or is ambiguous. Remove and re-add the order to reload its current items.`,
          "ORDER_ITEMS_CHANGED", 409
        );
      }
      const line = matches[0];
      const key = `${selection.orderNbr}:${line.id}`;
      const total = (totals.get(key) ?? 0) + item.qty;
      totals.set(key, total);
      const maximum = Math.min(line.openQty, line.allocatedQty);
      if (!Number.isFinite(item.qty) || item.qty <= 0 || !line.isAllocated || maximum <= 0 || total > maximum) {
        throw new PickupOrderVerificationError(
          `Item ${item.inventoryId} on ${selection.orderNbr} is no longer available in the requested quantity (available: ${Math.max(0, maximum)}). Reload the order.`,
          "ORDER_QUANTITY_CHANGED", 409
        );
      }
      item.lineId = line.id;
    }
  }
}
