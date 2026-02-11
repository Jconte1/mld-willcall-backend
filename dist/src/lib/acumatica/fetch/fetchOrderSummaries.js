"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = fetchOrderSummaries;
const node_https_1 = __importDefault(require("node:https"));
const denver_1 = require("../../time/denver");
async function fetchOrderSummaries(restService, baid, { pageSize: pageSizeArg, maxPages: maxPagesArg, useOrderBy = false, } = {}) {
    const token = await restService.getToken();
    const envPage = Number(process.env.ACU_PAGE_SIZE || "");
    const pageSize = Number.isFinite(envPage) && envPage > 0 ? envPage : (pageSizeArg || 250);
    const envMax = Number(process.env.ACU_MAX_PAGES || "");
    const maxPages = Number.isFinite(envMax) && envMax > 0 ? envMax : (maxPagesArg || 50);
    const cutoffDenver = (0, denver_1.oneYearAgoDenver)(new Date());
    const cutoffLiteral = (0, denver_1.toDenverDateTimeOffsetLiteral)(cutoffDenver);
    const base = `${restService.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
    const agent = new node_https_1.default.Agent({ keepAlive: true, maxSockets: 8 });
    const select = [
        "OrderNbr",
        "Status",
        "LocationID",
        "RequestedOn",
        "ShipVia",
        "JobName",
        "CustomerName",
        "DefaultSalesperson",
        "NoteID",
    ].join(",");
    const custom = "Document.AttributeBUYERGROUP";
    const excludedShipVia = [
        "DELIVERY SLC",
        "DELIVERY SW",
        "DIRECT SHIP",
        "GROUND",
        "MLD DROP SHIP",
        "NEXT DAY AIR",
        "RED LABEL",
        "2ND DAY AIR",
        "3RD DAY AIR",
        "COMMON CARRIER",
        "BEST WAY",
        "DEL ST GEORGE",
        "DELIVERY",
        "DELIVERY BOISE",
        "DELIVERY PROVO",
        "DELIVERY JACKSO",
        "DELIVERY KETCHU",
        "DELIVERY LAYTON",
        "DELIVERY PLUMBI",
        "RUSH",
        "TRANS BOISE",
        "TRANS JACKSON",
        "TRANS PROVO",
        "TRANS SLC",
        "WAIVER PROVO",
        "WAIVER SLC",
    ];
    const all = [];
    for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set("$filter", [
            `CustomerID eq '${baid}'`,
            `RequestedOn ge ${cutoffLiteral}`,
            "Status ne 'Canceled'",
            "Status ne 'On Hold'",
            "Status ne 'Pending Approval'",
            "Status ne 'Rejected'",
            "Status ne 'Pending Processing'",
            "Status ne 'Awaiting Payment'",
            "Status ne 'Credit Hold'",
            "Status ne 'Completed'",
            "Status ne 'Invoiced'",
            "Status ne 'Expired'",
            "Status ne 'Purchase Hold'",
            "Status ne 'Not Approved'",
            "Status ne 'Risk Hold'",
            ...excludedShipVia.map((v) => `ShipVia ne '${v}'`),
        ].join(" and "));
        params.set("$select", select);
        params.set("$custom", custom);
        if (useOrderBy)
            params.set("$orderby", "RequestedOn desc");
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
        if (!resp.ok)
            throw new Error(text || `ERP error for ${baid}`);
        const arr = text ? JSON.parse(text) : [];
        const rows = Array.isArray(arr) ? arr : Array.isArray(arr?.value) ? arr.value : [];
        all.push(...rows);
        console.log(`[fetchOrderSummaries] baid=${baid} page=${page} size=${pageSize} rows=${rows.length} ms=${ms} truncated=${rows.length === pageSize}`);
        if (rows.length < pageSize)
            break;
    }
    console.log(`[fetchOrderSummaries] baid=${baid} totalRows=${all.length}`);
    return all;
}
