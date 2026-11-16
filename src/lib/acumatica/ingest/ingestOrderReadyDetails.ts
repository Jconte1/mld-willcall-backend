import { prisma } from "../../prisma";

import { randomUUID } from "node:crypto";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchAddressContact from "../fetch/fetchAddressContact";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import writeAddressContact from "../write/writeAddressContact";
import writePaymentInfo from "../write/writePaymentInfo";
import writeInventoryDetails from "../write/writeInventoryDetails";
import { shouldUseQueueErp } from "../../queue/erpClient";

type RefreshInput = {
  baid: string;
  orderNbr: string;
  status?: string | null;
  erpLocationId?: string | null;
  shipVia?: string | null;
  lastModified?: Date | null;
};

const PICKUP_LOCATION_IDS = new Set([
  "slc-hq",
  "slc-outlet",
  "boise-willcall",
  "jackson-willcall",
  "provo-willcall",
]);

function normalizeErpLocationId(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (PICKUP_LOCATION_IDS.has(normalized.toLowerCase())) {
    return "__PICKUP_ID_BLOCKED__";
  }
  return normalized;
}

export async function refreshOrderReadyDetails(input: RefreshInput) {
  const { baid, orderNbr, erpLocationId, shipVia, lastModified } = input;
  const restService = createAcumaticaService();
  if (!shouldUseQueueErp()) {
    await restService.getToken();
  }

  const normalizedBaid = String(baid || "").trim();
  const normalizedOrderNbr = String(orderNbr || "").trim();
  const normalizedErpLocationId = normalizeErpLocationId(erpLocationId);
  if (normalizedErpLocationId === "__PICKUP_ID_BLOCKED__") {
    console.warn("[order-ready] blocked non-erp locationId write", {
      baid: normalizedBaid,
      orderNbr: normalizedOrderNbr,
      value: erpLocationId,
    });
  }

  const orderNbrs = [normalizedOrderNbr];
  const [addressRows, paymentRows, detailRows] = await Promise.all([
    fetchAddressContact(restService, normalizedBaid, { orderNbrs }),
    fetchPaymentInfo(restService, normalizedBaid, { orderNbrs }),
    fetchInventoryDetails(restService, normalizedBaid, orderNbrs),
  ]);
  const paymentRow = paymentRows.find((row) => String(row.OrderNbr?.value ?? row.OrderNbr ?? "").trim() === normalizedOrderNbr);
  const freshStatus = String(paymentRow?.Status?.value ?? paymentRow?.Status ?? "").trim();
  if (!freshStatus) throw new Error(`ERP did not verify current status for ${normalizedOrderNbr}`);
  const terminal = ["completed", "invoiced", "canceled", "cancelled", "closed", "expired"].includes(freshStatus.toLowerCase());
  if (!terminal && (detailRows.length !== 1 || !Array.isArray(detailRows[0]?.Details) ||
    String(detailRows[0]?.OrderNbr?.value ?? detailRows[0]?.OrderNbr ?? "").trim() !== normalizedOrderNbr)) {
    throw new Error(`ERP did not return a complete inventory snapshot for ${normalizedOrderNbr}`);
  }
  const now = new Date();
  const summaryUpdate: Record<string, any> = {
    status: freshStatus,
    shipVia: shipVia ?? null,
    lastSeenAt: now,
    isActive: true,
    updatedAt: now,
  };
  if (normalizedErpLocationId && normalizedErpLocationId !== "__PICKUP_ID_BLOCKED__") {
    summaryUpdate.locationId = normalizedErpLocationId;
  }
  if (lastModified !== undefined) {
    summaryUpdate.lastAcumaticaModifiedAt = lastModified;
  }

  await prisma.erpOrderSummary.upsert({
    where: { baid_orderNbr: { baid: normalizedBaid, orderNbr: normalizedOrderNbr } },
    create: {
      id: randomUUID(),
      baid: normalizedBaid,
      orderNbr: normalizedOrderNbr,
      status: freshStatus,
      locationId:
        normalizedErpLocationId && normalizedErpLocationId !== "__PICKUP_ID_BLOCKED__"
          ? normalizedErpLocationId
          : null,
      deliveryDate: null,
      jobName: null,
      shipVia: shipVia ?? null,
      customerName: "",
      buyerGroup: "",
      noteId: "",
      lastSeenAt: now,
      isActive: true,
      updatedAt: now,
      lastAcumaticaPullAt: null,
      lastAcumaticaModifiedAt: lastModified ?? null,
    },
    update: summaryUpdate,
  });

  await writeAddressContact(normalizedBaid, addressRows);
  await writePaymentInfo(normalizedBaid, paymentRows);
  await writeInventoryDetails(normalizedBaid, terminal ? [] : detailRows, { expectedOrderNbrs: orderNbrs });
  await prisma.erpOrderSummary.update({
    where: { baid_orderNbr: { baid: normalizedBaid, orderNbr: normalizedOrderNbr } },
    data: { lastAcumaticaPullAt: new Date() },
  });

  return { orderNbr: normalizedOrderNbr, refreshedAt: now };
}
