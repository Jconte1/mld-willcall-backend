import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchAddressContact from "../fetch/fetchAddressContact";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import writeAddressContact from "../write/writeAddressContact";
import writePaymentInfo from "../write/writePaymentInfo";
import writeInventoryDetails from "../write/writeInventoryDetails";
import { shouldUseQueueErp } from "../../queue/erpClient";

const prisma = new PrismaClient();

type RefreshInput = {
  baid: string;
  orderNbr: string;
  status?: string | null;
  erpLocationId?: string | null;
  shipVia?: string | null;
  lastModified?: Date | null;
};

const PICKUP_LOCATION_IDS = new Set(["slc-hq", "slc-outlet", "boise-willcall"]);

function normalizeErpLocationId(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (PICKUP_LOCATION_IDS.has(normalized.toLowerCase())) {
    return "__PICKUP_ID_BLOCKED__";
  }
  return normalized;
}

export async function refreshOrderReadyDetails(input: RefreshInput) {
  const { baid, orderNbr, status, erpLocationId, shipVia, lastModified } = input;
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

  const now = new Date();
  const summaryUpdate: Record<string, any> = {
    status: status ?? "Ready",
    shipVia: shipVia ?? null,
    lastSeenAt: now,
    isActive: true,
    updatedAt: now,
    lastAcumaticaPullAt: now,
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
      status: status ?? "Ready",
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
      lastAcumaticaPullAt: now,
      lastAcumaticaModifiedAt: lastModified ?? null,
    },
    update: summaryUpdate,
  });

  const orderNbrs = [normalizedOrderNbr];
  const [addressRows, paymentRows, detailRows] = await Promise.all([
    fetchAddressContact(restService, normalizedBaid, { orderNbrs }),
    fetchPaymentInfo(restService, normalizedBaid, { orderNbrs }),
    fetchInventoryDetails(restService, normalizedBaid, orderNbrs),
  ]);

  await writeAddressContact(normalizedBaid, addressRows);
  await writePaymentInfo(normalizedBaid, paymentRows);
  await writeInventoryDetails(normalizedBaid, detailRows);

  return { orderNbr: normalizedOrderNbr, refreshedAt: now };
}
