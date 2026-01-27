import { denver3amWindowStartLiteral } from "../../time/denver";

type AnyRow = Record<string, any>;

const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 50;

function normalizeDatetimeOffsetLiteral(input: string) {
  const raw = String(input || "").trim();
  const inner = raw.replace(/^datetimeoffset'|'+$/g, "");
  const match = inner.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{1,2}(?::?\d{2})?)$/);
  if (!match) return `datetimeoffset'${inner}'`;

  const base = match[1];
  const offsetRaw = match[2];
  let offset = offsetRaw;
  const offsetMatch = offsetRaw.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (offsetMatch) {
    const sign = offsetMatch[1];
    const hh = offsetMatch[2].padStart(2, "0");
    const mm = (offsetMatch[3] || "00").padStart(2, "0");
    offset = `${sign}${hh}:${mm}`;
  }

  return `datetimeoffset'${base}${offset}'`;
}

export default async function fetchOrderSummariesSince(
  restService: { baseUrl: string; getToken: () => Promise<string> },
  baid: string,
  {
    sinceLiteral,
    pageSize: pageSizeArg,
    maxPages: maxPagesArg,
    useOrderBy = false,
  }: {
    sinceLiteral?: string;
    pageSize?: number;
    maxPages?: number;
    useOrderBy?: boolean;
  } = {}
): Promise<AnyRow[]> {
  const token = await restService.getToken();

  const envPage = Number(process.env.ACU_PAGE_SIZE || "");
  const pageSize =
    Number.isFinite(envPage) && envPage > 0 ? envPage : pageSizeArg || DEFAULT_PAGE_SIZE;
  const envMax = Number(process.env.ACU_MAX_PAGES || "");
  const maxPages =
    Number.isFinite(envMax) && envMax > 0 ? envMax : maxPagesArg || DEFAULT_MAX_PAGES;

  const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
  const select = [
    "OrderNbr",
    "Status",
    "LocationID",
    "RequestedOn",
    "ShipVia",
    "JobName",
    "CustomerName",
    "NoteID",
    "LastModified",
  ].join(",");
  const custom = "Document.AttributeBUYERGROUP";

  // TODO: Confirm the ERP last-modified field name if this ever errors.
  const since = normalizeDatetimeOffsetLiteral(
    sinceLiteral ?? denver3amWindowStartLiteral(new Date())
  );

  const all: AnyRow[] = [];
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams();
    params.set(
      "$filter",
      [`CustomerID eq '${baid.replace(/'/g, "''")}'`, `LastModified ge ${since}`].join(
        " and "
      )
    );
    params.set("$select", select);
    params.set("$custom", custom);
    if (useOrderBy) params.set("$orderby", "LastModified desc");
    params.set("$top", String(pageSize));
    params.set("$skip", String(page * pageSize));

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
    if (!resp.ok) throw new Error(text || `ERP error for ${baid}`);

    const arr = text ? JSON.parse(text) : [];
    const rows = Array.isArray(arr) ? arr : Array.isArray((arr as any)?.value) ? (arr as any).value : [];
    all.push(...rows);

    console.log(
      `[fetchOrderSummariesSince] baid=${baid} page=${page} size=${pageSize} rows=${rows.length} ms=${ms} truncated=${rows.length === pageSize}`
    );
    if (rows.length < pageSize) break;
  }

  console.log(`[fetchOrderSummariesSince] baid=${baid} totalRows=${all.length}`);
  return all;
}
