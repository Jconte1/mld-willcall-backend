import https from "node:https";

import AcumaticaService from "./auth/acumaticaService";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

function createErpClient() {
  return new AcumaticaService(
    requireEnv("ACUMATICA_BASE_URL"),
    requireEnv("ACUMATICA_CLIENT_ID"),
    requireEnv("ACUMATICA_CLIENT_SECRET"),
    requireEnv("ACUMATICA_USERNAME"),
    requireEnv("ACUMATICA_PASSWORD")
  );
}

function odataEscape(value: string) {
  // OData escapes single quotes by doubling them.
  return value.replace(/'/g, "''");
}

type AnyJson = any;

const LOG_PREFIX = "[willcall][verify-baid][acumatica]";
const IS_DEV = process.env.NODE_ENV !== "production";

function safeJsonParse(text: string): AnyJson | null {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function truncate(str: string, max = 2000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + `… (truncated, ${str.length} chars)` : str;
}

async function fetchCustomerRowsByBaid(restService: AcumaticaService, baid: string): Promise<AnyJson[]> {
  const t0 = Date.now();

  const token = await restService.getToken();
  const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/Customer`;

  const params = new URLSearchParams();
  params.set("$top", "1");
  params.set("$filter", `CustomerID eq '${odataEscape(baid)}'`);

  const url = `${base}?${params.toString()}`;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

  if (IS_DEV) {
    console.log(`${LOG_PREFIX} -> request`, { baid, url });
  }

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    agent: agent as any,
  });

  const text = await resp.text().catch(() => "");
  const ms = Date.now() - t0;

  if (IS_DEV) {
    console.log(`${LOG_PREFIX} <- response`, {
      baid,
      status: resp.status,
      ok: resp.ok,
      ms,
      bytes: text.length,
    });

    // ✅ This is the raw Acumatica response body (capped)
    console.log(`${LOG_PREFIX} raw`, truncate(text, 2000));

    // ✅ Pretty JSON (capped)
    const json = safeJsonParse(text);
    if (json != null) {
      console.log(`${LOG_PREFIX} json`, truncate(JSON.stringify(json, null, 2), 4000));
    } else {
      console.log(`${LOG_PREFIX} json`, "(unable to parse JSON)");
    }
  }

  if (!resp.ok) {
    // Surface the ERP response body for debugging, but keep it bounded.
    throw new Error(truncate(text, 500) || `ERP error (${resp.status})`);
  }

  const json: AnyJson = safeJsonParse(text);

  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.value)) return json.value;
  return [];
}

/**
 * Returns true if the BAID exists in Acumatica.
 */
export async function verifyBaidInAcumatica(baid: string): Promise<boolean> {
  const cleaned = String(baid || "").trim().toUpperCase();
  if (!cleaned) return false;

  if (IS_DEV) console.log(`${LOG_PREFIX} start`, { baid: cleaned });

  const restService = createErpClient();
  const rows = await fetchCustomerRowsByBaid(restService, cleaned);

  const ok = Array.isArray(rows) && rows.length > 0;

  if (IS_DEV) console.log(`${LOG_PREFIX} result`, { baid: cleaned, ok, rows: rows.length });

  return ok;
}
