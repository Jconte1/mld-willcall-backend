"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyBaidInAcumatica = verifyBaidInAcumatica;
exports.diagnoseBaidZipInAcumatica = diagnoseBaidZipInAcumatica;
const node_https_1 = __importDefault(require("node:https"));
const acumaticaService_1 = __importDefault(require("./auth/acumaticaService"));
const erpClient_1 = require("../queue/erpClient");
function requireEnv(name) {
    const v = process.env[name]?.trim();
    if (!v) {
        throw new Error(`Missing env var: ${name}`);
    }
    return v;
}
function createErpClient() {
    return new acumaticaService_1.default(requireEnv("ACUMATICA_BASE_URL"), requireEnv("ACUMATICA_CLIENT_ID"), requireEnv("ACUMATICA_CLIENT_SECRET"), requireEnv("ACUMATICA_USERNAME"), requireEnv("ACUMATICA_PASSWORD"));
}
function odataEscape(value) {
    return value.replace(/'/g, "''");
}
const LOG_PREFIX = "[willcall][verify-baid][acumatica]";
const IS_DEV = process.env.NODE_ENV !== "production";
function safeJsonParse(text) {
    try {
        return text ? JSON.parse(text) : null;
    }
    catch {
        return null;
    }
}
function truncate(str, max = 2000) {
    if (!str)
        return "";
    return str.length > max ? str.slice(0, max) + `... (truncated, ${str.length} chars)` : str;
}
async function fetchCustomerRowsByBaid(restService, baid, zip) {
    const t0 = Date.now();
    const token = await restService.getToken();
    const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/Customer`;
    const params = new URLSearchParams();
    params.set("$top", "1");
    params.set("$filter", `CustomerID eq '${odataEscape(baid)}' and Zip5 eq '${odataEscape(zip)}'`);
    const url = `${base}?${params.toString()}`;
    const agent = new node_https_1.default.Agent({ keepAlive: true, maxSockets: 8 });
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
        console.log(`${LOG_PREFIX} raw`, truncate(text, 2000));
        const json = safeJsonParse(text);
        if (json != null) {
            console.log(`${LOG_PREFIX} json`, truncate(JSON.stringify(json, null, 2), 4000));
        }
        else {
            console.log(`${LOG_PREFIX} json`, "(unable to parse JSON)");
        }
    }
    if (!resp.ok) {
        throw new Error(truncate(text, 500) || `ERP error (${resp.status})`);
    }
    const json = safeJsonParse(text);
    if (Array.isArray(json))
        return json;
    if (Array.isArray(json?.value))
        return json.value;
    return [];
}
async function fetchCustomerRowsByCustomerId(restService, baid) {
    const token = await restService.getToken();
    const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/Customer`;
    const params = new URLSearchParams();
    params.set("$top", "10");
    params.set("$filter", `CustomerID eq '${odataEscape(baid)}'`);
    const url = `${base}?${params.toString()}`;
    if (IS_DEV) {
        console.log(`${LOG_PREFIX} -> customer-only request`, { baid, url });
    }
    const resp = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
    });
    const text = await resp.text().catch(() => "");
    if (IS_DEV) {
        console.log(`${LOG_PREFIX} <- customer-only response`, {
            baid,
            status: resp.status,
            ok: resp.ok,
            bytes: text.length,
        });
        console.log(`${LOG_PREFIX} customer-only raw`, truncate(text, 2000));
    }
    if (!resp.ok) {
        throw new Error(truncate(text, 500) || `ERP error (${resp.status})`);
    }
    const json = safeJsonParse(text);
    if (Array.isArray(json))
        return json;
    if (Array.isArray(json?.value))
        return json.value;
    return [];
}
async function verifyBaidViaQueue(baid, zip) {
    const resp = await (0, erpClient_1.queueErpJobRequest)("/api/erp/jobs/customers/verify", {
        customerId: baid,
        zip5: zip,
    });
    return {
        matched: Boolean(resp?.matched),
        comparedZip5: resp?.comparedZip5,
        candidateZip5: Array.isArray(resp?.candidateZip5) ? resp.candidateZip5 : [],
    };
}
async function verifyBaidInAcumatica(baid, zip) {
    const cleaned = String(baid || "").trim().toUpperCase();
    const cleanedZip = String(zip || "").replace(/\D/g, "").slice(0, 5);
    if (!cleaned)
        return false;
    if (cleanedZip.length !== 5)
        return false;
    if (IS_DEV)
        console.log(`${LOG_PREFIX} start`, { baid: cleaned });
    if ((0, erpClient_1.shouldUseQueueErp)()) {
        const queueResult = await verifyBaidViaQueue(cleaned, cleanedZip);
        const ok = queueResult.matched;
        if (IS_DEV)
            console.log("[willcall][verify-baid][queue] result", { baid: cleaned, ok });
        return ok;
    }
    const restService = createErpClient();
    const rows = await fetchCustomerRowsByBaid(restService, cleaned, cleanedZip);
    let ok = Array.isArray(rows) && rows.length > 0;
    if (!ok) {
        const candidateRows = await fetchCustomerRowsByCustomerId(restService, cleaned);
        const candidateZip5 = Array.from(new Set(candidateRows
            .map((row) => String(row?.Zip5 ?? row?.ZipCode ?? row?.PostalCode ?? row?.Zip ?? "")
            .replace(/\D/g, "")
            .slice(0, 5))
            .filter((value) => value.length === 5)));
        ok = candidateZip5.includes(cleanedZip);
    }
    if (IS_DEV)
        console.log(`${LOG_PREFIX} result`, { baid: cleaned, ok, rows: rows.length });
    return ok;
}
async function diagnoseBaidZipInAcumatica(baid, providedZip) {
    const cleaned = String(baid || "").trim().toUpperCase();
    const normalizedZip = String(providedZip || "").replace(/\D/g, "").slice(0, 5);
    if (!cleaned || normalizedZip.length !== 5) {
        return {
            mode: (0, erpClient_1.shouldUseQueueErp)() ? "queue" : "acumatica",
            baid: cleaned,
            providedZip,
            normalizedZip,
            matched: false,
            candidateZip5: [],
        };
    }
    if ((0, erpClient_1.shouldUseQueueErp)()) {
        const queueResult = await verifyBaidViaQueue(cleaned, normalizedZip);
        return {
            mode: "queue",
            baid: cleaned,
            providedZip,
            normalizedZip: queueResult.comparedZip5 || normalizedZip,
            matched: queueResult.matched,
            candidateZip5: queueResult.candidateZip5 || [],
        };
    }
    const restService = createErpClient();
    const matchedRows = await fetchCustomerRowsByBaid(restService, cleaned, normalizedZip);
    const matched = matchedRows.length > 0;
    const allRows = await fetchCustomerRowsByCustomerId(restService, cleaned);
    const candidateZip5 = Array.from(new Set(allRows
        .map((row) => String(row?.Zip5 ?? row?.ZipCode ?? row?.PostalCode ?? row?.Zip ?? "").replace(/\D/g, "").slice(0, 5))
        .filter((zip) => zip.length === 5)));
    return {
        mode: "acumatica",
        baid: cleaned,
        providedZip,
        normalizedZip,
        matched,
        candidateZip5,
    };
}
