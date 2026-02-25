import https from "node:https";
import { queueErpRequest, shouldUseQueueErp } from "../../queue/erpClient";
import type { QueueRowsResponse } from "../../queue/contracts";

type AnyRow = Record<string, any>;

export default async function fetchAddressContact(
  restService: { baseUrl: string; getToken: () => Promise<string> },
  baid: string,
  {
    orderNbrs = [],
    chunkSize = 40,
    pageSize = 500,
    useOrderBy = false,
    cutoffLiteral = null,
  }: {
    orderNbrs?: string[];
    chunkSize?: number;
    pageSize?: number;
    useOrderBy?: boolean;
    cutoffLiteral?: string | null;
  } = {}
): Promise<AnyRow[]> {
  if (shouldUseQueueErp()) {
    const resp = await queueErpRequest<QueueRowsResponse<AnyRow>>("/api/erp/orders/address-contact", {
      method: "POST",
      body: { baid, orderNbrs, cutoffLiteral, pageSize, chunkSize, useOrderBy },
    });
    const rows = Array.isArray(resp?.rows) ? resp.rows : [];
    console.log(`[fetchAddressContact][queue] baid=${baid} totalRows=${rows.length}`);
    return rows;
  }

  const token = await restService.getToken();
  const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  const select = [
    "OrderNbr",
    "AddressLine1",
    "AddressLine2",
    "City",
    "State",
    "PostalCode",
    "DeliveryEmail",
    "JobName",
    "ShipVia",
  ].join(",");
  const custom =
    "Document.AttributeSITENUMBER, Document.AttributeOSCONTACT, Document.AttributeCONFIRMVIA, Document.AttributeCONFIRMWTH";

  const fetchOnce = async (filter: string, skip = 0) => {
    const params = new URLSearchParams();
    params.set("$filter", filter);
    params.set("$select", select);
    params.set("$custom", custom);
    if (useOrderBy) params.set("$orderby", "OrderNbr desc");
    params.set("$top", String(pageSize));
    params.set("$skip", String(skip));
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
        `[fetchAddressContact] baid=${baid} ERROR status=${resp.status} body=${text?.slice(0, 500)}`
      );
      throw new Error(text || `ERP error fetching address/contact for baid=${baid}`);
    }
    let json: AnyRow[] | { value?: AnyRow[] } = [];
    try {
      json = text ? JSON.parse(text) : [];
    } catch {
      json = [];
    }
    const rows = Array.isArray(json) ? json : Array.isArray(json?.value) ? json.value : [];
    return { rows, ms, truncated: rows.length === pageSize };
  };

  const all: AnyRow[] = [];
  const baidLit = baid.replace(/'/g, "''");
  const baseParts = [`CustomerID eq '${baidLit}'`];
  if (cutoffLiteral) baseParts.push(`RequestedOn ge ${cutoffLiteral}`);

  if (Array.isArray(orderNbrs) && orderNbrs.length) {
    const chunks: string[][] = [];
    for (let i = 0; i < orderNbrs.length; i += chunkSize) {
      chunks.push(orderNbrs.slice(i, i + chunkSize));
    }
    console.log(
      `[fetchAddressContact] baid=${baid} orderChunks=${chunks.length} chunkSize~=${chunkSize} pageSize=${pageSize}`
    );
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const ors = chunk
        .map((n) => String(n).replace(/'/g, "''"))
        .map((n) => `OrderNbr eq '${n}'`)
        .join(" or ");
      const filter = [...baseParts, `(${ors})`].join(" and ");
      let skip = 0;
      let page = 0;
      while (true) {
        const { rows, ms, truncated } = await fetchOnce(filter, skip);
        console.log(
          `[fetchAddressContact] baid=${baid} chunk=${ci + 1}/${chunks.length} page=${page} size=${pageSize} rows=${rows.length} ms=${ms} truncated=${truncated}`
        );
        all.push(...rows);
        page += 1;
        skip += pageSize;
        if (!truncated) break;
      }
    }
    console.log(`[fetchAddressContact] baid=${baid} totalRows=${all.length}`);
    return all;
  }

  const filter = baseParts.join(" and ");
  let skip = 0;
  let page = 0;
  while (true) {
    const { rows, ms, truncated } = await fetchOnce(filter, skip);
    console.log(
      `[fetchAddressContact] baid=${baid} (fallback) page=${page} size=${pageSize} rows=${rows.length} ms=${ms} truncated=${truncated}`
    );
    all.push(...rows);
    page += 1;
    skip += pageSize;
    if (!truncated) break;
  }
  console.log(`[fetchAddressContact] baid=${baid} totalRows=${all.length} (fallback)`);
  return all;
}