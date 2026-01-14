"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = fetchPaymentInfo;
const node_https_1 = __importDefault(require("node:https"));
const node_fetch_1 = __importDefault(require("node-fetch"));
async function fetchPaymentInfo(restService, baid, { orderNbrs = [], chunkSize = Number(process.env.PAYMENTS_CHUNK_SIZE || 20), pageSize = 500, } = {}) {
    if (!Array.isArray(orderNbrs) || !orderNbrs.length) {
        console.log(`[fetchPaymentInfo] baid=${baid} no orderNbrs provided`);
        return [];
    }
    const token = await restService.getToken();
    const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
    const agent = new node_https_1.default.Agent({ keepAlive: true, maxSockets: 8 });
    const select = ["OrderNbr", "OrderTotal", "UnpaidBalance", "Terms", "Status"].join(",");
    const chunks = chunk(orderNbrs, Math.max(1, chunkSize));
    const all = [];
    console.log(`[fetchPaymentInfo] baid=${baid} orderChunks=${chunks.length} chunkSize~=${chunkSize}`);
    const baidLit = baid.replace(/'/g, "''");
    const fetchOnce = async (filter) => {
        const params = new URLSearchParams();
        params.set("$filter", filter);
        params.set("$select", select);
        params.set("$top", String(pageSize));
        const url = `${base}?${params.toString()}`;
        const t0 = Date.now();
        const resp = await (0, node_fetch_1.default)(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
            agent: agent,
        });
        const ms = Date.now() - t0;
        const text = await resp.text();
        if (!resp.ok) {
            console.error(`[fetchPaymentInfo] baid=${baid} ERROR status=${resp.status} body=${text?.slice(0, 500)}`);
            throw new Error(text || `ERP error for ${baid}`);
        }
        let arr = [];
        try {
            arr = text ? JSON.parse(text) : [];
        }
        catch {
            arr = [];
        }
        const rows = Array.isArray(arr) ? arr : [];
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
        console.log(`[fetchPaymentInfo] baid=${baid} batch=${i + 1}/${chunks.length} orders=${batch.length} rows=${rows.length} ms=${ms}`);
    }
    console.log(`[fetchPaymentInfo] baid=${baid} totalRows=${all.length}`);
    return all;
}
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
