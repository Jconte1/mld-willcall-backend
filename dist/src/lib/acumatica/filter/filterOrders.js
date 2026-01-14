"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = filterOrders;
const denver_1 = require("../../time/denver");
function val(row, key) {
    const v = row?.[key];
    if (v && typeof v === "object" && "value" in v)
        return v.value;
    return v;
}
function toDate(v) {
    const d = v ? new Date(v) : null;
    return d && !isNaN(+d) ? d : null;
}
function optStr(v) {
    if (v == null)
        return null;
    if (typeof v === "string") {
        const s = v.trim();
        return s ? s : null;
    }
    return String(v);
}
function filterOrders(rawRows) {
    const cutoff = (0, denver_1.oneYearAgoDenver)(new Date());
    const normalized = [];
    let droppedMissing = 0;
    let droppedExcluded = 0;
    for (const row of rawRows || []) {
        const orderNbr = val(row, "OrderNbr") ?? row?.orderNbr ?? null;
        const status = val(row, "Status") ?? row?.status ?? null;
        const locationId = val(row, "LocationID") ?? row?.locationId ?? null;
        const requestedOnRaw = val(row, "RequestedOn") ?? row?.requestedOn ?? row?.deliveryDate ?? null;
        const shipVia = val(row, "ShipVia") ?? row?.shipVia ?? null;
        const jobName = val(row, "JobName") ?? row?.jobName ?? null;
        const customerName = val(row, "CustomerName") ?? row?.customerName ?? null;
        const buyerGroup = row?.custom?.Document?.AttributeBUYERGROUP?.value ??
            row?.buyerGroup ??
            null;
        const noteId = val(row, "NoteID") ?? row?.noteId ?? null;
        if (!orderNbr || !status || !requestedOnRaw) {
            droppedMissing += 1;
            continue;
        }
        if (String(orderNbr).startsWith("QT") || String(orderNbr).startsWith("RMA")) {
            droppedExcluded += 1;
            continue;
        }
        const requestedOn = toDate(requestedOnRaw);
        if (!requestedOn) {
            droppedMissing += 1;
            continue;
        }
        normalized.push({
            orderNbr: String(orderNbr),
            status: String(status),
            locationId: locationId != null ? String(locationId) : null,
            requestedOn: requestedOn.toISOString(),
            shipVia: optStr(shipVia),
            jobName: optStr(jobName),
            customerName: optStr(customerName),
            buyerGroup: optStr(buyerGroup),
            noteId: optStr(noteId),
        });
    }
    const cutoffISO = cutoff.toISOString();
    const withinWindow = [];
    let droppedOld = 0;
    for (const item of normalized) {
        if (item.requestedOn >= cutoffISO)
            withinWindow.push(item);
        else
            droppedOld += 1;
    }
    const byNbr = new Map();
    for (const item of withinWindow) {
        const prev = byNbr.get(item.orderNbr);
        if (!prev || item.requestedOn > prev.requestedOn)
            byNbr.set(item.orderNbr, item);
    }
    const deduped = Array.from(byNbr.values());
    return {
        kept: deduped,
        counts: {
            totalFromERP: Array.isArray(rawRows) ? rawRows.length : 0,
            droppedMissing,
            droppedExcluded,
            droppedOld,
            kept: deduped.length,
        },
        cutoff,
    };
}
