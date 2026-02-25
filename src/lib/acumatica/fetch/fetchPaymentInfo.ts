import https from "node:https";
import { queueErpJobRequest, shouldUseQueueErp } from "../../queue/erpClient";
import type { QueueRowsResponse } from "../../queue/contracts";

type AnyRow = Record<string, any>;

export default async function fetchPaymentInfo(
  restService: { baseUrl: string; getToken: () => Promise<string> },
  baid: string,
  {
    orderNbrs = [],
    chunkSize = Number(process.env.PAYMENTS_CHUNK_SIZE || 20),
    pageSize = 500,
  }: {
    orderNbrs?: string[];
    chunkSize?: number;
    pageSize?: number;
  } = {}
): Promise<AnyRow[]> {
  if (!Array.isArray(orderNbrs) || !orderNbrs.length) {
    console.log(`[fetchPaymentInfo] baid=${baid} no orderNbrs provided`);
    return [];
  }

  if (shouldUseQueueErp()) {
    const resp = await queueErpJobRequest<QueueRowsResponse<AnyRow>>("/api/erp/jobs/orders/payment-info", {
      baid,
      orderNbrs,
    });
    const rows = Array.isArray(resp?.rows) ? resp.rows : [];
    console.log(`[fetchPaymentInfo][queue] baid=${baid} totalRows=${rows.length}`);
    return rows;
  }

  const token = await restService.getToken();
  const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  const select = ["OrderNbr", "OrderTotal", "UnpaidBalance", "Terms", "Status"].join(",");

  const chunks = chunk(orderNbrs, Math.max(1, chunkSize));
  const all: AnyRow[] = [];
  console.log(
    `[fetchPaymentInfo] baid=${baid} orderChunks=${chunks.length} chunkSize~=${chunkSize}`
  );

  const baidLit = baid.replace(/'/g, "''");

  const fetchOnce = async (filter: string) => {
    const params = new URLSearchParams();
    params.set("$filter", filter);
    params.set("$select", select);
    params.set("$top", String(pageSize));
    const url = `${base}?${params.toString()}`;
    const t0 = Date.now();
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    const ms = Date.now() - t0;
    const text = await resp.text();
    if (!resp.ok) {
      console.error(
        `[fetchPaymentInfo] baid=${baid} ERROR status=${resp.status} body=${text?.slice(0, 500)}`
      );
      throw new Error(text || `ERP error for ${baid}`);
    }
    let arr: AnyRow[] | { value?: AnyRow[] } = [];
    try {
      arr = text ? JSON.parse(text) : [];
    } catch {
      arr = [];
    }
    const rows = Array.isArray(arr) ? arr : Array.isArray(arr?.value) ? arr.value : [];
    return { rows, ms };
  };

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    const ors = batch
      .map((n) => String(n).replace(/'/g, "''"))
      .map((n) => `OrderNbr eq '${n}'`)
      .join(" or ");
    const filter = [`CustomerID eq '${baidLit}'`, `(${ors})`].join(" and ");
    const { rows, ms } = await fetchOnce(filter);
    all.push(...rows);
    console.log(
      `[fetchPaymentInfo] baid=${baid} batch=${i + 1}/${chunks.length} orders=${batch.length} rows=${rows.length} ms=${ms}`
    );
  }

  console.log(`[fetchPaymentInfo] baid=${baid} totalRows=${all.length}`);
  return all;
}

function chunk(arr: string[], size: number) {
  const out: string[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
