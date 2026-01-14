"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = fetchInventoryDetails;
const node_https_1 = __importDefault(require("node:https"));
const node_fetch_1 = __importDefault(require("node-fetch"));
async function fetchInventoryDetails(restService, baid, orderNbrs, { batchSize = Number(process.env.LINES_BATCH_SIZE || 16), pool = Number(process.env.LINES_POOL || 4), maxSockets = Number(process.env.LINES_MAX_SOCKETS || 8), retries = Number(process.env.LINES_RETRIES || 4), maxUrl = Number(process.env.ACUMATICA_MAX_URL || 7000), timeoutMs = Number(process.env.LINES_TIMEOUT_MS || 25000), minDelayMs = Number(process.env.LINES_MIN_DELAY_MS || 150), } = {}) {
    if (!Array.isArray(orderNbrs) || orderNbrs.length === 0)
        return [];
    const token = await restService.getToken();
    const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
    const agent = new node_https_1.default.Agent({ keepAlive: true, maxSockets });
    const select = [
        "OrderNbr",
        "Details/InventoryID",
        "Details/LineDescription",
        "Details/LineType",
        "Details/UnitPrice",
        "Details/OpenQty",
        "Details/OrderQty",
        "Details/Amount",
        "Details/UsrETA",
        "Details/Here",
        "Details/Allocations/Allocated",
        "Details/Allocations/Qty",
        "Details/WarehouseID",
        "Details/TaxZone"
    ].join(",");
    const chunks = chunk(orderNbrs, Math.max(1, batchSize));
    const all = [];
    let lastHit = 0;
    async function pace() {
        const now = Date.now();
        const delta = now - lastHit;
        if (delta < minDelayMs)
            await sleep(minDelayMs - delta);
        lastHit = Date.now();
    }
    const fetchBatchAdaptive = async (batch, batchIndex, totalBatches, depth = 0) => {
        const ors = batch
            .map((n) => String(n).replace(/'/g, "''"))
            .map((n) => `OrderNbr eq '${n}'`)
            .join(" or ");
        const blockedStatuses = [
            "Canceled",
            "Cancelled",
            "On Hold",
            "Pending Approval",
            "Rejected",
            "Pending Processing",
            "Awaiting Payment",
            "Credit Hold",
            "Completed",
            "Invoiced",
            "Expired",
            "Purchase Hold",
            "Not Approved",
            "Risk Hold",
        ];
        const statusClauses = blockedStatuses.map((s) => `Status ne '${s.replace(/'/g, "''")}'`);
        statusClauses.push("Status ne ''");
        const filter = [
            `CustomerID eq '${String(baid).replace(/'/g, "''")}'`,
            `(${ors})`,
            ...statusClauses,
        ].join(" and ");
        const params = new URLSearchParams();
        params.set("$filter", filter);
        params.set("$select", select);
        params.set("$expand", "Details,Details/Allocations");
        params.set("$top", String(500));
        const url = `${base}?${params.toString()}`;
        if (url.length > maxUrl && batch.length > 1) {
            const mid = Math.floor(batch.length / 2);
            await fetchBatchAdaptive(batch.slice(0, mid), batchIndex, totalBatches, depth + 1);
            await fetchBatchAdaptive(batch.slice(mid), batchIndex, totalBatches, depth + 1);
            return;
        }
        const attemptFetch = async (attempt) => {
            await pace();
            if (attempt > 0)
                await sleep(15 + Math.floor(Math.random() * 25));
            const controller = new AbortController();
            const t0 = Date.now();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            let resp;
            let text = "";
            try {
                resp = await (0, node_fetch_1.default)(url, {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        "Accept-Encoding": "gzip, deflate",
                        Authorization: `Bearer ${token}`,
                    },
                    agent: agent,
                    signal: controller.signal,
                });
                text = await resp.text();
            }
            finally {
                clearTimeout(timeout);
            }
            const ms = Date.now() - t0;
            if (!resp.ok) {
                const status = resp.status;
                const body = (text || "").toString();
                const splitWorthy = status === 413 ||
                    status === 414 ||
                    status === 429 ||
                    body.includes("custom error module does not recognize this error") ||
                    (status === 400 && url.length > Math.floor(maxUrl * 0.8));
                if (splitWorthy && batch.length > 1) {
                    console.warn(`[fetchInventoryDetails] split batch (status=${status}) urlLen=${url.length} depth=${depth} baid=${baid} size=${batch.length}`);
                    const mid = Math.floor(batch.length / 2);
                    await fetchBatchAdaptive(batch.slice(0, mid), batchIndex, totalBatches, depth + 1);
                    await fetchBatchAdaptive(batch.slice(mid), batchIndex, totalBatches, depth + 1);
                    return;
                }
                if ((status === 429 || (status >= 500 && status < 600)) && attempt < retries) {
                    let wait = 0;
                    const ra = resp.headers?.get?.("retry-after");
                    if (ra) {
                        const secs = Number(ra);
                        if (Number.isFinite(secs)) {
                            wait = Math.max(0, Math.floor(secs * 1000));
                        }
                        else {
                            const until = Date.parse(ra);
                            if (Number.isFinite(until))
                                wait = Math.max(0, until - Date.now());
                        }
                    }
                    if (wait === 0) {
                        wait = 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
                    }
                    console.warn(`[fetchInventoryDetails] retry ${attempt + 1}/${retries} baid=${baid} batch=${batchIndex + 1}/${totalBatches} status=${status} wait=${wait}ms`);
                    await sleep(wait);
                    return attemptFetch(attempt + 1);
                }
                throw new Error(body || `ERP error (status ${status}) for ${baid}`);
            }
            let rows = [];
            try {
                const json = text ? JSON.parse(text) : [];
                rows = Array.isArray(json) ? json : Array.isArray(json?.value) ? json.value : [];
            }
            catch {
                rows = [];
            }
            all.push(...rows);
            console.log(`[fetchInventoryDetails] baid=${baid} batch=${batchIndex + 1}/${totalBatches} depth=${depth} orders=${batch.length} rows=${rows.length} ms=${ms}`);
        };
        await attemptFetch(0);
    };
    await poolRun(chunks, Math.max(1, pool), async (batch, idx) => fetchBatchAdaptive(batch, idx, chunks.length));
    console.log(`[fetchInventoryDetails] baid=${baid} totalRows=${all.length} batches=${chunks.length} pool=${pool} batchSize=${batchSize}`);
    return all;
}
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
async function poolRun(items, concurrency, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length)
                break;
            await worker(items[idx], idx);
        }
    });
    await Promise.all(runners);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
