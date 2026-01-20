import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createAcumaticaService } from "../createAcumaticaService";
import fetchAddressContact from "../fetch/fetchAddressContact";
import fetchPaymentInfo from "../fetch/fetchPaymentInfo";
import fetchInventoryDetails from "../fetch/fetchInventoryDetails";
import writeAddressContact from "../write/writeAddressContact";
import writePaymentInfo from "../write/writePaymentInfo";
import writeInventoryDetails from "../write/writeInventoryDetails";

const prisma = new PrismaClient();

type RefreshInput = {
  baid: string;
  orderNbr: string;
  status?: string | null;
  locationId?: string | null;
  shipVia?: string | null;
};

export async function refreshOrderReadyDetails(input: RefreshInput) {
  const { baid, orderNbr, status, locationId, shipVia } = input;
  const restService = createAcumaticaService();
  await restService.getToken();

  const now = new Date();
  await prisma.erpOrderSummary.upsert({
    where: { baid_orderNbr: { baid, orderNbr } },
    create: {
      id: randomUUID(),
      baid,
      orderNbr,
      status: status ?? "Ready",
      locationId: locationId ?? null,
      deliveryDate: null,
      jobName: null,
      shipVia: shipVia ?? null,
      customerName: "",
      buyerGroup: "",
      noteId: "",
      lastSeenAt: now,
      isActive: true,
      updatedAt: now,
    },
    update: {
      status: status ?? "Ready",
      locationId: locationId ?? null,
      shipVia: shipVia ?? null,
      lastSeenAt: now,
      isActive: true,
      updatedAt: now,
    },
  });

  const orderNbrs = [orderNbr];
  const [addressRows, paymentRows, detailRows] = await Promise.all([
    fetchAddressContact(restService, baid, { orderNbrs }),
    fetchPaymentInfo(restService, baid, { orderNbrs }),
    fetchInventoryDetails(restService, baid, orderNbrs),
  ]);

  await writeAddressContact(baid, addressRows);
  await writePaymentInfo(baid, paymentRows);
  await writeInventoryDetails(baid, detailRows);

  return { orderNbr, refreshedAt: now };
}
