"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickupsRouter = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const locationIds_1 = require("../lib/locationIds");
const ingestOrderReadyDetails_1 = require("../lib/acumatica/ingest/ingestOrderReadyDetails");
const refreshPrepayPayments_1 = require("../lib/acumatica/sync/refreshPrepayPayments");
const createAcumaticaService_1 = require("../lib/acumatica/createAcumaticaService");
const erpClient_1 = require("../lib/queue/erpClient");
const pickupHours_1 = require("../lib/pickupHours");
const pickupClosures_1 = require("../lib/pickupClosures");
const prisma_1 = require("../lib/prisma");
const notifications_1 = require("../notifications");
exports.pickupsRouter = (0, express_1.Router)();
const LOCATION_IDS = [
    "slc-hq",
    "slc-outlet",
    "boise-willcall",
    "jackson-willcall",
    "provo-willcall",
];
exports.pickupsRouter.use(auth_1.requireAuth);
exports.pickupsRouter.use(auth_1.blockIfMustChangePassword);
exports.pickupsRouter.use(auth_1.blockIfMustCompleteProfile);
const STATUS = zod_1.z.enum([
    "Scheduled",
    "Confirmed",
    "InProgress",
    "Ready",
    "Completed",
    "Cancelled",
    "NoShow",
]);
const availabilityQuerySchema = zod_1.z.object({
    locationId: zod_1.z.enum(LOCATION_IDS),
    from: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const selectedItemSchema = zod_1.z.object({
    lineId: zod_1.z.string().optional(),
    inventoryId: zod_1.z.string().min(1),
    qty: zod_1.z.number().positive(),
    description: zod_1.z.string().optional().nullable(),
    warehouse: zod_1.z.string().optional().nullable(),
    maxQty: zod_1.z.number().optional(),
});
const selectedItemsSchema = zod_1.z.object({
    orderNbr: zod_1.z.string().min(1),
    items: zod_1.z.array(selectedItemSchema),
});
const SHIPMENT_FORMAT = /^SMT\d{7}$/;
const PREPAY_TERMS = new Set(["PP", "PPP", "PPT", "TRADE", "CONTRACT"]);
const PREPAY_MIN_DUE = 1;
const SLOT_MINUTES = 15;
const DENVER_TZ = "America/Denver";
const ACTIVE_APPOINTMENT_STATUSES = [
    client_1.PickupAppointmentStatus.Scheduled,
    client_1.PickupAppointmentStatus.Confirmed,
    client_1.PickupAppointmentStatus.InProgress,
    client_1.PickupAppointmentStatus.Ready,
];
function getMinAdvanceMinutes(locationId) {
    if (locationId === "boise-willcall")
        return 2 * 60;
    if (locationId === "jackson-willcall")
        return 0;
    return 4 * 60;
}
const shipmentUpdateSchema = zod_1.z.object({
    orderNbr: zod_1.z.string().min(1),
    shipmentNbrs: zod_1.z.array(zod_1.z.string().min(1)).default([]),
});
function canAccessLocation(req, locationId) {
    if (req.auth.role === "ADMIN")
        return true;
    return (0, locationIds_1.expandLocationIds)(req.auth.locationAccess ?? []).includes(locationId);
}
function canCreatePickups(req) {
    return req.auth?.role !== "VIEWER";
}
function canModifyPickups(req) {
    return req.auth?.role === "ADMIN" || req.auth?.role === "STAFF";
}
function normalizeOrderNbr(value) {
    return value.trim().toUpperCase();
}
function uniqueOrderNbrs(values) {
    if (!values?.length)
        return [];
    return Array.from(new Set(values.map(normalizeOrderNbr).filter(Boolean)));
}
function toNumber(value) {
    if (value == null)
        return 0;
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}
function formatDenverDateTime(input) {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    }).format(input);
}
function formatDateInDenver(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value ?? "0000";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const d = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${d}`;
}
function formatTimeInDenver(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hh}:${mm}`;
}
function parseDateOnly(dateStr) {
    return new Date(`${dateStr}T12:00:00-07:00`);
}
function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}
function timeToMinutes(time) {
    const [hh, mm] = time.split(":").map((part) => Number(part));
    return hh * 60 + mm;
}
function pad(num) {
    return String(num).padStart(2, "0");
}
function minutesToTime(totalMinutes) {
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return `${pad(hh)}:${pad(mm)}`;
}
function getSlotStarts(startAt, endAt) {
    const starts = [];
    for (let cursor = new Date(startAt); cursor < endAt; cursor = addMinutes(cursor, SLOT_MINUTES)) {
        starts.push({
            date: formatDateInDenver(cursor),
            startTime: formatTimeInDenver(cursor),
        });
    }
    return starts;
}
async function findManualBlockConflict(client, locationId, startAt, endAt) {
    const slots = getSlotStarts(startAt, endAt);
    if (!slots.length)
        return null;
    return client.pickupManualBlock.findFirst({
        where: {
            locationId,
            OR: slots.map((slot) => ({ date: slot.date, startTime: slot.startTime })),
        },
        select: { date: true, startTime: true },
    });
}
function isWeekend(dateStr) {
    const date = parseDateOnly(dateStr);
    const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: DENVER_TZ,
        weekday: "short",
    }).format(date);
    return weekday === "Sat" || weekday === "Sun";
}
function isClosedDate(dateStr, locationId) {
    return isWeekend(dateStr) || (0, pickupClosures_1.isHolidayClosure)(dateStr, locationId);
}
function nextBusinessDateStr(dateStr, locationId) {
    let cursor = parseDateOnly(dateStr);
    while (true) {
        cursor = addMinutes(cursor, 24 * 60);
        const next = formatDateInDenver(cursor);
        if (!isClosedDate(next, locationId))
            return next;
    }
}
function ceilToSlot(minutes) {
    return Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}
function getMinAllowedSlot(now, locationId) {
    let cursorDateStr = formatDateInDenver(now);
    let cursorMinutes = timeToMinutes(formatTimeInDenver(now));
    let remainingAdvance = getMinAdvanceMinutes(locationId);
    while (true) {
        const { openHour, closeHour } = (0, pickupHours_1.getPickupHours)(locationId);
        const openMinutes = openHour * 60;
        const closeMinutes = closeHour * 60;
        if (isClosedDate(cursorDateStr, locationId)) {
            cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
            cursorMinutes = (0, pickupHours_1.getPickupHours)(locationId).openHour * 60;
            continue;
        }
        if (cursorMinutes < openMinutes)
            cursorMinutes = openMinutes;
        if (cursorMinutes >= closeMinutes) {
            cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
            cursorMinutes = (0, pickupHours_1.getPickupHours)(locationId).openHour * 60;
            continue;
        }
        const availableToday = closeMinutes - cursorMinutes;
        if (remainingAdvance <= availableToday) {
            let minMinutes = ceilToSlot(cursorMinutes + remainingAdvance);
            const lastStartMinutes = closeMinutes - SLOT_MINUTES;
            if (minMinutes > lastStartMinutes) {
                cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
                const { openHour: nextOpenHour } = (0, pickupHours_1.getPickupHours)(locationId);
                minMinutes = nextOpenHour * 60;
            }
            return { dateStr: cursorDateStr, minutes: minMinutes };
        }
        remainingAdvance -= availableToday;
        cursorDateStr = nextBusinessDateStr(cursorDateStr, locationId);
        cursorMinutes = (0, pickupHours_1.getPickupHours)(locationId).openHour * 60;
    }
}
function isBeforeMinAdvance(startAt, now, locationId) {
    const minAllowed = getMinAllowedSlot(now, locationId);
    const startDateStr = formatDateInDenver(startAt);
    const startMinutes = timeToMinutes(formatTimeInDenver(startAt));
    return (startDateStr < minAllowed.dateStr ||
        (startDateStr === minAllowed.dateStr && startMinutes < minAllowed.minutes));
}
function buildStaffSlotsForDate(locationId, dateStr, manualBlocks, appointmentBlocks, minStartMinutes) {
    if (isClosedDate(dateStr, locationId))
        return [];
    const slots = [];
    const { openHour, closeHour } = (0, pickupHours_1.getPickupHours)(locationId);
    const startMinutes = openHour * 60;
    const lastStartMinutes = closeHour * 60 - SLOT_MINUTES;
    for (let minutes = startMinutes; minutes <= lastStartMinutes; minutes += SLOT_MINUTES) {
        const startTime = minutesToTime(minutes);
        const endTime = minutesToTime(minutes + SLOT_MINUTES);
        const manuallyBlocked = manualBlocks.has(startTime);
        const occupied = appointmentBlocks.has(startTime);
        const tooEarly = minStartMinutes != null && minutes < minStartMinutes;
        slots.push({
            id: `slot-${dateStr.replace(/-/g, "")}-${startTime.replace(":", "")}`,
            startTime,
            endTime,
            available: !tooEarly && !manuallyBlocked && !occupied,
            manuallyBlocked,
            occupied,
            tooEarly,
        });
    }
    return slots;
}
async function findActiveOrderConflicts(orderNbrs, excludeAppointmentId) {
    if (!orderNbrs.length)
        return [];
    const appointmentWhere = {
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
    };
    if (excludeAppointmentId) {
        appointmentWhere.id = { not: excludeAppointmentId };
    }
    const rows = await prisma_1.prisma.pickupAppointmentOrder.findMany({
        where: {
            orderNbr: { in: orderNbrs },
            appointment: appointmentWhere,
        },
        include: {
            appointment: {
                select: {
                    id: true,
                    status: true,
                    startAt: true,
                    endAt: true,
                },
            },
        },
        orderBy: [{ appointment: { startAt: "asc" } }],
    });
    return rows.map((row) => ({
        orderNbr: row.orderNbr,
        appointmentId: row.appointmentId,
        status: row.appointment.status,
        startAt: row.appointment.startAt,
        endAt: row.appointment.endAt,
        displayAt: formatDenverDateTime(row.appointment.startAt),
    }));
}
async function findOrderSummary(orderNbr) {
    return prisma_1.prisma.erpOrderSummary.findFirst({
        where: { orderNbr, isActive: true },
        orderBy: [{ updatedAt: "desc" }],
        include: {
            ErpOrderPayment: true,
            ErpOrderLine: true,
        },
    });
}
async function refreshOrderFromSalesOrderEndpoint(orderNbrInput) {
    const orderNbr = normalizeOrderNbr(orderNbrInput);
    console.info("[staff-pickups][lookup] salesorder fallback start", { orderNbr });
    let row = null;
    if ((0, erpClient_1.shouldUseQueueErp)()) {
        const resp = await (0, erpClient_1.queueErpJobRequest)("/api/erp/jobs/orders/header", { orderNbr });
        if (!resp?.found || !resp.row) {
            console.info("[staff-pickups][lookup] salesorder fallback no match", { orderNbr });
            return false;
        }
        row = resp.row;
    }
    else {
        const service = (0, createAcumaticaService_1.createAcumaticaService)();
        const token = await service.getToken();
        const base = `${service.baseUrl}/entity/CustomEndpoint/24.200.001/SalesOrder`;
        const safeOrderNbr = orderNbr.replace(/'/g, "''");
        const params = new URLSearchParams();
        params.set("$filter", `OrderNbr eq '${safeOrderNbr}'`);
        params.set("$select", [
            "OrderNbr",
            "Status",
            "LocationID",
            "ShipVia",
            "CustomerID",
            "LastModified",
        ].join(","));
        params.set("$top", "1");
        const url = `${base}?${params.toString()}`;
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(text || `SalesOrder lookup failed (${res.status})`);
        }
        const parsed = text ? JSON.parse(text) : [];
        const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.value) ? parsed.value : [];
        if (!rows.length) {
            console.info("[staff-pickups][lookup] salesorder fallback no match", { orderNbr });
            return false;
        }
        row = rows[0] ?? {};
    }
    const baid = String(row?.CustomerID?.value ?? row?.CustomerID ?? "").trim();
    if (!baid) {
        console.warn("[staff-pickups][lookup] salesorder fallback missing baid", { orderNbr });
        return false;
    }
    const status = String(row?.Status?.value ?? row?.Status ?? "Open");
    const shipVia = String(row?.ShipVia?.value ?? row?.ShipVia ?? "").trim() || null;
    const locationId = String(row?.LocationID?.value ?? row?.LocationID ?? "").trim() || null;
    const lastModifiedRaw = row?.LastModified?.value ?? row?.LastModified ?? null;
    const lastModified = lastModifiedRaw && !Number.isNaN(new Date(lastModifiedRaw).getTime())
        ? new Date(lastModifiedRaw)
        : null;
    await (0, ingestOrderReadyDetails_1.refreshOrderReadyDetails)({
        baid,
        orderNbr,
        status,
        shipVia,
        erpLocationId: locationId,
        lastModified,
    });
    console.info("[staff-pickups][lookup] salesorder fallback complete", {
        orderNbr,
        baid,
        status,
        shipVia,
        locationId,
    });
    return true;
}
async function getOrRefreshOrderDetail(orderNbrInput, options) {
    const orderNbr = normalizeOrderNbr(orderNbrInput);
    const forceFresh = Boolean(options?.forceFresh);
    console.info("[staff-pickups][lookup] start", { orderNbr });
    let summary = await findOrderSummary(orderNbr);
    if (summary) {
        console.info("[staff-pickups][lookup] db hit", {
            orderNbr,
            baid: summary.baid,
            status: summary.status,
            lineCount: summary.ErpOrderLine.length,
            hasPayment: Boolean(summary.ErpOrderPayment),
        });
    }
    else {
        console.info("[staff-pickups][lookup] db miss", { orderNbr });
    }
    if (summary && forceFresh) {
        try {
            console.info("[staff-pickups][lookup] forced refresh start", {
                orderNbr,
                baid: summary.baid,
            });
            await (0, ingestOrderReadyDetails_1.refreshOrderReadyDetails)({
                baid: summary.baid,
                orderNbr,
                status: summary.status,
                shipVia: summary.shipVia,
                erpLocationId: summary.locationId,
            });
            summary = await findOrderSummary(orderNbr);
            console.info("[staff-pickups][lookup] forced refresh result", {
                orderNbr,
                found: Boolean(summary),
                lineCount: summary?.ErpOrderLine?.length ?? 0,
            });
        }
        catch (err) {
            console.error("[staff-pickups][lookup] forced refresh failed", {
                orderNbr,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (!summary) {
        const notice = await prisma_1.prisma.orderReadyNotice.findUnique({
            where: { orderNbr },
            select: {
                baid: true,
                status: true,
                shipVia: true,
                locationId: true,
            },
        });
        if (notice?.baid) {
            console.info("[staff-pickups][lookup] orderReadyNotice fallback start", {
                orderNbr,
                baid: notice.baid,
            });
            try {
                await (0, ingestOrderReadyDetails_1.refreshOrderReadyDetails)({
                    baid: notice.baid,
                    orderNbr,
                    status: notice.status,
                    shipVia: notice.shipVia,
                });
            }
            catch (err) {
                console.error("[staff-pickups] refresh from orderReadyNotice failed", {
                    orderNbr,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            summary = await findOrderSummary(orderNbr);
            console.info("[staff-pickups][lookup] orderReadyNotice fallback result", {
                orderNbr,
                found: Boolean(summary),
            });
        }
    }
    if (!summary) {
        try {
            const refreshed = await refreshOrderFromSalesOrderEndpoint(orderNbr);
            console.info("[staff-pickups][lookup] salesorder fallback result", {
                orderNbr,
                refreshed,
            });
            if (refreshed) {
                summary = await findOrderSummary(orderNbr);
            }
        }
        catch (err) {
            console.error("[staff-pickups] refresh from order-ready report failed", {
                orderNbr,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (!summary) {
        console.warn("[staff-pickups][lookup] not found after all fallbacks", { orderNbr });
        return null;
    }
    try {
        await (0, refreshPrepayPayments_1.refreshPrepayPaymentsIfNeeded)({
            baid: summary.baid,
            orderNbrs: [orderNbr],
            context: "staff-pickups-order-lookup",
        });
    }
    catch (err) {
        console.warn("[payment-refresh][staff-pickups-order-lookup] fallback to DB payment", {
            baid: summary.baid,
            orderNbr,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    const paymentRow = await prisma_1.prisma.erpOrderPayment.findFirst({
        where: {
            baid: summary.baid,
            orderNbr,
        },
        select: {
            orderTotal: true,
            unpaidBalance: true,
            otherFees: true,
            terms: true,
            status: true,
        },
    });
    const payment = {
        orderTotal: toNumber(paymentRow?.orderTotal),
        otherFees: toNumber(paymentRow?.otherFees),
        unpaidBalance: toNumber(paymentRow?.unpaidBalance),
        terms: paymentRow?.terms ?? null,
        status: paymentRow?.status ?? null,
    };
    const salesPerson = summary.salesPersonNumber
        ? await prisma_1.prisma.staffUser.findFirst({
            where: { salespersonNumber: summary.salesPersonNumber },
            select: {
                salespersonNumber: true,
                salespersonName: true,
                salespersonPhone: true,
                salespersonEmail: true,
            },
        })
        : null;
    const lines = summary.ErpOrderLine.map((line) => ({
        id: line.id,
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        warehouse: line.warehouse,
        openQty: toNumber(line.openQty),
        orderQty: toNumber(line.orderQty),
        allocatedQty: toNumber(line.allocatedQty),
        isAllocated: line.isAllocated,
        amount: toNumber(line.amount),
        taxRate: toNumber(line.taxRate),
    })).sort((a, b) => (a.inventoryId ?? "").localeCompare(b.inventoryId ?? ""));
    const lineAmountTotal = lines.reduce((sum, line) => sum + (line.amount || 0), 0);
    const lineTaxTotal = lines.reduce((sum, line) => {
        const orderQty = line.orderQty || 0;
        if (orderQty <= 0)
            return sum;
        const perUnitPreTax = (line.amount || 0) / orderQty;
        const perUnitTax = perUnitPreTax * ((line.taxRate || 0) / 100);
        return sum + perUnitTax * orderQty;
    }, 0);
    const computedOtherFees = Math.max(0, Math.round((payment.orderTotal - lineAmountTotal - lineTaxTotal) * 100) / 100);
    payment.otherFees = computedOtherFees;
    return {
        orderNbr,
        baid: summary.baid,
        status: summary.status,
        shipVia: summary.shipVia ?? null,
        payment,
        salesPerson: salesPerson
            ? {
                number: salesPerson.salespersonNumber,
                name: salesPerson.salespersonName,
                phone: salesPerson.salespersonPhone,
                email: salesPerson.salespersonEmail,
            }
            : null,
        lines,
    };
}
function findPrepayBlock(detail, selectedItems) {
    if (String(detail.orderNbr || "").trim().toUpperCase().startsWith("R1"))
        return null;
    const terms = (detail.payment.terms ?? "").trim().toUpperCase();
    if (!PREPAY_TERMS.has(terms))
        return null;
    const selectedMap = new Map((selectedItems?.items ?? []).map((item) => [item.lineId ?? item.inventoryId, item]));
    const unpaidBalance = detail.payment.unpaidBalance;
    const otherFees = detail.payment.otherFees;
    const openLines = detail.lines.filter((line) => Math.max(0, line.openQty) > 0);
    const allOpenQtySelected = openLines.length > 0 &&
        openLines.every((line) => {
            const key = line.id || line.inventoryId || "";
            const selected = selectedMap.get(key);
            const selectedQty = selected ? selected.qty : 0;
            return selectedQty >= Math.max(0, line.openQty);
        });
    if (allOpenQtySelected) {
        const amountOwed = Math.max(0, unpaidBalance);
        if (amountOwed < PREPAY_MIN_DUE)
            return null;
        return {
            orderNbr: detail.orderNbr,
            amountOwed: Math.round(amountOwed * 100) / 100,
        };
    }
    const remainingGoodsWithTax = detail.lines.reduce((sum, line) => {
        const key = line.id || line.inventoryId || "";
        const selected = selectedMap.get(key);
        const selectedQty = selected ? selected.qty : 0;
        const remainingQty = Math.max(0, line.openQty - selectedQty);
        const orderQty = line.orderQty;
        if (orderQty <= 0 || remainingQty <= 0)
            return sum;
        const perUnitPreTax = line.amount / orderQty;
        const perUnitTax = perUnitPreTax * (line.taxRate / 100);
        return sum + remainingQty * (perUnitPreTax + perUnitTax);
    }, 0);
    const remainingWithFees = remainingGoodsWithTax + otherFees;
    const retainRequired = remainingWithFees * 0.5;
    const amountOwed = Math.max(0, unpaidBalance - retainRequired);
    if (amountOwed < PREPAY_MIN_DUE)
        return null;
    return {
        orderNbr: detail.orderNbr,
        amountOwed: Math.round(amountOwed * 100) / 100,
    };
}
function normalizeSelections(selectedItems, allowedOrders) {
    if (!selectedItems?.length)
        return [];
    const allowed = new Set(allowedOrders);
    return selectedItems
        .filter((selection) => allowed.has(selection.orderNbr))
        .map((selection) => ({
        orderNbr: selection.orderNbr,
        items: selection.items.filter((item) => item.inventoryId && item.qty > 0),
    }))
        .filter((selection) => selection.items.length > 0);
}
async function validateSelectedItemQty(selectedItems) {
    if (!selectedItems?.length)
        return null;
    const lineIds = Array.from(new Set(selectedItems.flatMap((selection) => selection.items.map((item) => item.lineId).filter(Boolean))));
    if (!lineIds.length)
        return null;
    const lines = await prisma_1.prisma.erpOrderLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, openQty: true, orderNbr: true },
    });
    const lineMap = new Map(lines.map((line) => [line.id, line]));
    for (const selection of selectedItems) {
        for (const item of selection.items) {
            if (!item.lineId)
                continue;
            const line = lineMap.get(item.lineId);
            if (!line)
                continue;
            const openQty = line.openQty == null ? null : Number(line.openQty);
            if (openQty != null && item.qty > openQty) {
                return {
                    orderNbr: selection.orderNbr,
                    lineId: item.lineId,
                    maxQty: openQty,
                };
            }
        }
    }
    return null;
}
function areSelectedItemsEqual(a, b) {
    const normalize = (items) => items
        .flatMap((selection) => selection.items.map((item) => ({
        orderNbr: selection.orderNbr,
        lineId: item.lineId ?? "",
        inventoryId: item.inventoryId,
        qty: Number(item.qty),
    })))
        .sort((x, y) => `${x.orderNbr}-${x.lineId}-${x.inventoryId}`.localeCompare(`${y.orderNbr}-${y.lineId}-${y.inventoryId}`));
    const left = normalize(a);
    const right = normalize(b);
    if (left.length !== right.length)
        return false;
    return left.every((item, idx) => item.orderNbr === right[idx].orderNbr &&
        item.lineId === right[idx].lineId &&
        item.inventoryId === right[idx].inventoryId &&
        item.qty === right[idx].qty);
}
function normalizeShipmentNbr(input) {
    return input.trim().toUpperCase();
}
function validateShipmentNbrs(input) {
    const normalized = input.map(normalizeShipmentNbr).filter(Boolean);
    const invalid = normalized.find((value) => !SHIPMENT_FORMAT.test(value));
    if (invalid) {
        return { ok: false, invalid };
    }
    return { ok: true, values: Array.from(new Set(normalized)) };
}
/**
 * GET /api/staff/pickups
 * Optional query: locationId, status, from, to
 */
exports.pickupsRouter.get("/", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    console.info("[staff-pickups] request", {
        id: req.auth.id,
        email: req.auth.email,
        role: req.auth.role,
        mustChangePassword: req.auth.mustChangePassword,
        mustCompleteProfile: req.auth.mustCompleteProfile,
        locationAccess: req.auth.locationAccess ?? [],
        query: req.query,
    });
    const auth = req.auth;
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if (locationId && !canAccessLocation(req, locationId)) {
        console.warn("[staff-pickups] forbidden location", {
            id: auth.id,
            role: auth.role,
            locationId,
            locationAccess: auth.locationAccess ?? [],
        });
        return res.status(403).json({ message: "Forbidden" });
    }
    const where = {};
    if (locationId) {
        const expanded = (0, locationIds_1.expandLocationIds)([locationId]);
        where.locationId = { in: expanded };
    }
    if (status) {
        const parsed = STATUS.safeParse(status);
        if (!parsed.success)
            return res.status(400).json({ message: "Invalid status" });
        where.status = parsed.data;
    }
    if (from) {
        const fromDate = new Date(from);
        if (Number.isNaN(fromDate.getTime())) {
            return res.status(400).json({ message: "Invalid from date" });
        }
        // Treat YYYY-MM-DD as a full-day lower bound in UTC.
        fromDate.setUTCHours(0, 0, 0, 0);
        where.startAt = { ...(where.startAt ?? {}), gte: fromDate };
    }
    if (to) {
        const toDate = new Date(to);
        if (Number.isNaN(toDate.getTime())) {
            return res.status(400).json({ message: "Invalid to date" });
        }
        // Treat YYYY-MM-DD as a full-day upper bound in UTC.
        toDate.setUTCHours(23, 59, 59, 999);
        where.startAt = { ...(where.startAt ?? {}), lte: toDate };
    }
    // Staff scope by their locations (if no locationId explicitly provided)
    if (auth.role !== "ADMIN" && !locationId) {
        where.locationId = { in: (0, locationIds_1.expandLocationIds)(auth.locationAccess ?? []) };
    }
    const pickups = await prisma_1.prisma.pickupAppointment.findMany({
        where,
        orderBy: { startAt: "asc" },
        include: { orders: true, shipments: true },
    });
    const normalized = pickups.map((pickup) => ({
        ...pickup,
        locationId: (0, locationIds_1.normalizeLocationId)(pickup.locationId) ?? pickup.locationId,
    }));
    return res.json({ pickups: normalized });
});
/**
 * GET /api/staff/pickups/availability?locationId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.pickupsRouter.get("/availability", async (req, res) => {
    if (!req.auth)
        return res.status(401).json({ message: "Unauthenticated" });
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ message: "Invalid query parameters" });
    }
    const { locationId, from, to } = parsed.data;
    if (!canAccessLocation(req, locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const now = new Date();
    const minAllowed = getMinAllowedSlot(now, locationId);
    const rangeStart = parseDateOnly(from);
    const rangeEnd = addMinutes(parseDateOnly(to), 24 * 60);
    const appointments = await prisma_1.prisma.pickupAppointment.findMany({
        where: {
            locationId,
            status: { in: ACTIVE_APPOINTMENT_STATUSES },
            startAt: { lt: rangeEnd },
            endAt: { gt: rangeStart },
        },
        select: { startAt: true, endAt: true },
    });
    const manualBlocks = await prisma_1.prisma.pickupManualBlock.findMany({
        where: {
            locationId,
            date: { gte: from, lte: to },
        },
        select: { date: true, startTime: true },
    });
    const manualBlocksByDate = new Map();
    for (const block of manualBlocks) {
        const slots = manualBlocksByDate.get(block.date) ?? new Set();
        slots.add(block.startTime);
        manualBlocksByDate.set(block.date, slots);
    }
    const appointmentBlocksByDate = new Map();
    for (const appointment of appointments) {
        for (const slot of getSlotStarts(appointment.startAt, appointment.endAt)) {
            const slots = appointmentBlocksByDate.get(slot.date) ?? new Set();
            slots.add(slot.startTime);
            appointmentBlocksByDate.set(slot.date, slots);
        }
    }
    const availability = [];
    for (let cursor = new Date(rangeStart); cursor < rangeEnd; cursor = addMinutes(cursor, 24 * 60)) {
        const dateStr = formatDateInDenver(cursor);
        let minStartMinutes = null;
        if (dateStr < minAllowed.dateStr) {
            minStartMinutes = Infinity;
        }
        else if (dateStr === minAllowed.dateStr) {
            minStartMinutes = minAllowed.minutes;
        }
        availability.push({
            date: dateStr,
            isBlackedOut: isClosedDate(dateStr, locationId),
            slots: buildStaffSlotsForDate(locationId, dateStr, manualBlocksByDate.get(dateStr) ?? new Set(), appointmentBlocksByDate.get(dateStr) ?? new Set(), minStartMinutes),
        });
    }
    return res.json({ availability });
});
/**
 * PATCH /api/staff/pickups/availability
 * Body: { locationId, changes: [{ date, startTime, available }] }
 */
exports.pickupsRouter.patch("/availability", async (req, res) => {
    if (!canModifyPickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z
        .object({
        locationId: zod_1.z.enum(LOCATION_IDS),
        changes: zod_1.z
            .array(zod_1.z.object({
            date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            startTime: zod_1.z.string().regex(/^\d{2}:\d{2}$/),
            available: zod_1.z.boolean(),
        }))
            .nonempty(),
    })
        .safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    if (!canAccessLocation(req, body.data.locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const invalidChange = body.data.changes.find((change) => {
        if (isClosedDate(change.date, body.data.locationId))
            return true;
        const [hours, minutes] = change.startTime.split(":").map(Number);
        const startMinutes = hours * 60 + minutes;
        const { openHour, closeHour } = (0, pickupHours_1.getPickupHours)(body.data.locationId);
        return (Number.isNaN(startMinutes) ||
            minutes % SLOT_MINUTES !== 0 ||
            startMinutes < openHour * 60 ||
            startMinutes >= closeHour * 60);
    });
    if (invalidChange) {
        return res.status(400).json({ message: "Invalid availability change." });
    }
    const blocksToCreate = body.data.changes.filter((change) => !change.available);
    const blocksToRemove = body.data.changes.filter((change) => change.available);
    await prisma_1.prisma.$transaction(async (tx) => {
        if (blocksToRemove.length) {
            await tx.pickupManualBlock.deleteMany({
                where: {
                    locationId: body.data.locationId,
                    OR: blocksToRemove.map((change) => ({ date: change.date, startTime: change.startTime })),
                },
            });
        }
        if (blocksToCreate.length) {
            await tx.pickupManualBlock.createMany({
                data: blocksToCreate.map((change) => ({
                    locationId: body.data.locationId,
                    date: change.date,
                    startTime: change.startTime,
                    createdByUserId: req.auth?.id ?? null,
                })),
                skipDuplicates: true,
            });
        }
    });
    return res.json({ updated: body.data.changes.length });
});
/**
 * POST /api/staff/pickups/orders/lookup
 * Body: { orderNbr }
 */
exports.pickupsRouter.post("/orders/lookup", async (req, res) => {
    if (!canCreatePickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z
        .object({
        orderNbr: zod_1.z.string().min(1),
    })
        .safeParse(req.body);
    if (!body.success) {
        console.warn("[staff-pickups][lookup] invalid request body", { body: req.body });
        return res.status(400).json({ message: "Invalid request body" });
    }
    console.info("[staff-pickups][lookup] endpoint hit", {
        orderNbr: body.data.orderNbr,
        userId: req.auth?.id,
        role: req.auth?.role,
    });
    const normalizedOrderNbr = normalizeOrderNbr(body.data.orderNbr);
    const detail = await getOrRefreshOrderDetail(body.data.orderNbr, { forceFresh: true });
    if (!detail) {
        console.warn("[staff-pickups][lookup] endpoint not found", {
            orderNbr: body.data.orderNbr,
        });
        return res.status(404).json({ message: "Order not found." });
    }
    console.info("[staff-pickups][lookup] endpoint success", {
        orderNbr: detail.orderNbr,
        baid: detail.baid,
        lineCount: detail.lines.length,
        terms: detail.payment.terms,
        unpaidBalance: detail.payment.unpaidBalance,
    });
    return res.json({ order: detail });
});
/**
 * POST /api/staff/pickups
 * Body: { locationId, customerEmail, customerFirstName, customerLastName?, customerPhone?, startAt, endAt, status?, orderNbrs? }
 */
exports.pickupsRouter.post("/", async (req, res) => {
    if (!canCreatePickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z.object({
        locationId: zod_1.z.enum(LOCATION_IDS),
        customerEmail: zod_1.z.string().email(),
        customerFirstName: zod_1.z.string().min(1),
        customerLastName: zod_1.z.string().optional(),
        customerPhone: zod_1.z.string().optional(),
        vehicleInfo: zod_1.z.string().optional(),
        customerNotes: zod_1.z.string().optional(),
        startAt: zod_1.z.string().datetime(),
        endAt: zod_1.z.string().datetime().optional(),
        status: STATUS.optional(),
        orderNbrs: zod_1.z.array(zod_1.z.string()).optional(),
        selectedItems: zod_1.z.array(selectedItemsSchema).optional(),
        prepayOverride: zod_1.z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    console.info("[staff-pickups][create] start", {
        userId: req.auth?.id,
        role: req.auth?.role,
        locationId: req.body?.locationId,
        customerEmail: req.body?.customerEmail,
        orderCount: Array.isArray(req.body?.orderNbrs) ? req.body.orderNbrs.length : 0,
        selectedItemsCount: Array.isArray(req.body?.selectedItems) ? req.body.selectedItems.length : 0,
        prepayOverride: Boolean(req.body?.prepayOverride),
    });
    if (!canAccessLocation(req, body.data.locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const customerEmail = body.data.customerEmail.toLowerCase();
    const isSalesperson = req.auth?.role === "SALESPERSON";
    const canUsePrepayOverride = req.auth?.role === "ADMIN" || req.auth?.role === "STAFF";
    const prepayOverride = canUsePrepayOverride && Boolean(body.data.prepayOverride);
    if (body.data.prepayOverride && !canUsePrepayOverride) {
        return res.status(403).json({ message: "Prepay override is only available to staff/admin." });
    }
    const startAt = new Date(body.data.startAt);
    const endAt = new Date(startAt.getTime() + SLOT_MINUTES * 60000);
    if (Number.isNaN(startAt.getTime())) {
        console.warn("[staff-pickups][create] invalid time range", {
            startAt: body.data.startAt,
            endAt: body.data.endAt ?? null,
        });
        return res.status(400).json({ message: "Invalid appointment time range." });
    }
    if (startAt.getSeconds() !== 0 || startAt.getMilliseconds() !== 0 || startAt.getMinutes() % SLOT_MINUTES !== 0) {
        return res.status(400).json({ message: "Start time must be on a 15-minute interval." });
    }
    if (startAt <= new Date()) {
        return res.status(400).json({ message: "Appointment start time must be in the future." });
    }
    if (isSalesperson && isBeforeMinAdvance(startAt, new Date(), body.data.locationId)) {
        return res.status(400).json({ message: "Selected time is too soon. Please choose a later slot." });
    }
    const slotConflict = await prisma_1.prisma.pickupAppointment.findFirst({
        where: {
            locationId: body.data.locationId,
            status: { in: ACTIVE_APPOINTMENT_STATUSES },
            startAt: { lt: endAt },
            endAt: { gt: startAt },
        },
        select: { id: true, startAt: true, endAt: true },
    });
    if (slotConflict) {
        return res.status(409).json({
            message: "Time slot no longer available.",
            code: "SLOT_UNAVAILABLE",
            conflict: {
                appointmentId: slotConflict.id,
                startAt: slotConflict.startAt,
                endAt: slotConflict.endAt,
            },
        });
    }
    const manualBlockConflict = await findManualBlockConflict(prisma_1.prisma, body.data.locationId, startAt, endAt);
    if (manualBlockConflict) {
        return res.status(409).json({
            message: "Time slot is manually blocked.",
            code: "SLOT_MANUALLY_BLOCKED",
            conflict: manualBlockConflict,
        });
    }
    const user = await prisma_1.prisma.users.findUnique({ where: { email: customerEmail } });
    const orderNbrs = uniqueOrderNbrs(body.data.orderNbrs);
    if (!orderNbrs.length) {
        console.warn("[staff-pickups][create] blocked: no orders");
        return res.status(400).json({ message: "At least one order is required." });
    }
    const activeConflicts = await findActiveOrderConflicts(orderNbrs);
    if (activeConflicts.length) {
        const first = activeConflicts[0];
        const message = `Order ${first.orderNbr} already has an active pickup appointment scheduled for ${first.displayAt}.`;
        console.warn("[staff-pickups][create] blocked: active order conflict", {
            orderNbrs,
            conflicts: activeConflicts.map((c) => ({
                orderNbr: c.orderNbr,
                appointmentId: c.appointmentId,
                status: c.status,
                at: c.displayAt,
            })),
        });
        return res.status(409).json({
            message,
            code: "ORDER_ALREADY_SCHEDULED",
            conflicts: activeConflicts,
        });
    }
    const normalizedSelections = normalizeSelections(body.data.selectedItems, orderNbrs);
    const totalSelectedCount = normalizedSelections.reduce((sum, selection) => sum + selection.items.length, 0);
    if (totalSelectedCount === 0) {
        console.warn("[staff-pickups][create] blocked: no selected items", {
            orderNbrs,
        });
        return res.status(400).json({ message: "Select at least one item." });
    }
    const invalidQty = await validateSelectedItemQty(normalizedSelections);
    if (invalidQty) {
        console.warn("[staff-pickups][create] blocked: selected qty exceeds open qty", invalidQty);
        return res.status(400).json({
            message: "Selected quantity exceeds open quantity.",
            orderNbr: invalidQty.orderNbr,
            lineId: invalidQty.lineId,
            maxQty: invalidQty.maxQty,
        });
    }
    const details = await Promise.all(orderNbrs.map((orderNbr) => getOrRefreshOrderDetail(orderNbr)));
    const missingOrder = details.find((detail) => !detail);
    if (missingOrder) {
        console.warn("[staff-pickups][create] blocked: missing order detail", { orderNbrs });
        return res.status(404).json({ message: "One or more orders were not found." });
    }
    const detailMap = new Map(details.filter(Boolean).map((detail) => [detail.orderNbr, detail]));
    for (const selection of normalizedSelections) {
        const detail = detailMap.get(selection.orderNbr);
        if (!detail) {
            return res.status(404).json({ message: `Order ${selection.orderNbr} was not found.` });
        }
        const lineMap = new Map(detail.lines.map((line) => [line.id, line]));
        const inventoryMap = new Map(detail.lines
            .filter((line) => line.inventoryId)
            .map((line) => [String(line.inventoryId), line]));
        for (const item of selection.items) {
            const lineId = item.lineId ?? "";
            const line = lineMap.get(lineId) ?? inventoryMap.get(item.inventoryId);
            if (!line) {
                console.warn("[staff-pickups][create] blocked: selected line missing", {
                    orderNbr: selection.orderNbr,
                    inventoryId: item.inventoryId,
                    lineId: item.lineId ?? null,
                });
                return res.status(400).json({
                    message: `Selected line is not available on order ${selection.orderNbr}.`,
                });
            }
            if (!line.isAllocated || line.allocatedQty <= 0) {
                console.warn("[staff-pickups][create] blocked: item not allocated", {
                    orderNbr: selection.orderNbr,
                    inventoryId: line.inventoryId,
                    lineId: line.id,
                    allocatedQty: line.allocatedQty,
                    isAllocated: line.isAllocated,
                });
                return res.status(400).json({
                    message: `Item ${line.inventoryId ?? "line"} is not ready for pickup on ${selection.orderNbr}.`,
                });
            }
            if (item.qty > line.openQty) {
                console.warn("[staff-pickups][create] blocked: item qty exceeds open qty", {
                    orderNbr: selection.orderNbr,
                    inventoryId: line.inventoryId,
                    requestedQty: item.qty,
                    openQty: line.openQty,
                });
                return res.status(400).json({
                    message: `Selected quantity exceeds open quantity for ${selection.orderNbr}.`,
                });
            }
        }
    }
    if (!prepayOverride) {
        for (const orderNbr of orderNbrs) {
            const detail = detailMap.get(orderNbr);
            if (!detail)
                continue;
            const selection = normalizedSelections.find((row) => row.orderNbr === orderNbr);
            const block = findPrepayBlock(detail, selection);
            if (block) {
                console.warn("[staff-pickups][create] blocked: prepay required", block);
                return res.status(409).json({
                    message: "Payment required before pickup.",
                    code: "PREPAY_BLOCKED",
                    orderNbr: block.orderNbr,
                    amountOwed: block.amountOwed,
                });
            }
        }
    }
    const created = await prisma_1.prisma.$transaction(async (tx) => {
        const appointment = await tx.pickupAppointment.create({
            data: {
                userId: user?.id ?? null,
                email: customerEmail,
                pickupReference: orderNbrs.join(", "),
                locationId: body.data.locationId,
                startAt,
                endAt,
                status: isSalesperson
                    ? client_1.PickupAppointmentStatus.Scheduled
                    : body.data.status
                        ? body.data.status
                        : undefined,
                customerFirstName: body.data.customerFirstName,
                customerLastName: body.data.customerLastName ?? null,
                customerEmail: customerEmail,
                customerPhone: body.data.customerPhone ?? null,
                smsOptIn: Boolean(body.data.customerPhone),
                smsOptInAt: body.data.customerPhone ? new Date() : null,
                smsOptInSource: body.data.customerPhone ? "staff-create-appointment" : null,
                smsOptInPhone: body.data.customerPhone ?? null,
                emailOptIn: true,
                emailOptInAt: new Date(),
                emailOptInSource: "staff-create-appointment",
                emailOptInEmail: customerEmail,
                vehicleInfo: body.data.vehicleInfo ?? null,
                customerNotes: body.data.customerNotes ?? null,
            },
        });
        if (orderNbrs.length) {
            await tx.pickupAppointmentOrder.createMany({
                data: orderNbrs.map((orderNbr) => ({
                    appointmentId: appointment.id,
                    orderNbr,
                })),
                skipDuplicates: true,
            });
        }
        const lineRows = normalizedSelections.flatMap((selection) => selection.items.map((item) => ({
            appointmentId: appointment.id,
            orderNbr: selection.orderNbr,
            lineId: item.lineId ?? null,
            inventoryId: item.inventoryId,
            qtySelected: item.qty,
            lineDescription: item.description ?? null,
        })));
        if (lineRows.length) {
            await tx.pickupAppointmentLine.createMany({ data: lineRows });
        }
        return appointment;
    });
    try {
        await (0, notifications_1.notifyStaffScheduled)(prisma_1.prisma, created, orderNbrs);
    }
    catch (err) {
        console.error("[notifications] staff schedule failed", err);
    }
    console.info("[staff-pickups][create] success", {
        appointmentId: created.id,
        orderNbrs,
        locationId: created.locationId,
        status: created.status,
        customerEmail: created.customerEmail,
    });
    return res.status(201).json({ pickup: created });
});
/**
 * GET /api/staff/pickups/:id
 */
exports.pickupsRouter.get("/:id", async (req, res) => {
    const pickup = await prisma_1.prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, shipments: true },
    });
    if (!pickup)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, pickup.locationId))
        return res.status(403).json({ message: "Forbidden" });
    return res.json({
        pickup: {
            ...pickup,
            locationId: (0, locationIds_1.normalizeLocationId)(pickup.locationId) ?? pickup.locationId,
        },
    });
});
/**
 * GET /api/staff/pickups/:id/items
 */
exports.pickupsRouter.get("/:id/items", async (req, res) => {
    const pickup = await prisma_1.prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, lines: true, shipments: true },
    });
    if (!pickup)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, pickup.locationId))
        return res.status(403).json({ message: "Forbidden" });
    const orderNbrs = pickup.orders.map((order) => order.orderNbr);
    const orderLines = await prisma_1.prisma.erpOrderLine.findMany({
        where: { orderNbr: { in: orderNbrs } },
        select: {
            id: true,
            orderNbr: true,
            inventoryId: true,
            lineDescription: true,
            openQty: true,
            orderQty: true,
            warehouse: true,
            allocatedQty: true,
            isAllocated: true,
            amount: true,
            taxRate: true,
        },
        orderBy: [{ orderNbr: "asc" }],
    });
    return res.json({
        pickupId: pickup.id,
        orderNbrs,
        lines: pickup.lines,
        orderLines,
        shipments: pickup.shipments,
    });
});
/**
 * PATCH /api/staff/pickups/:id/shipments
 * Body: { shipments: [{ orderNbr, shipmentNbrs: string[] }] }
 */
exports.pickupsRouter.patch("/:id/shipments", async (req, res) => {
    if (!canModifyPickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z
        .object({
        shipments: zod_1.z.array(shipmentUpdateSchema),
    })
        .safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const appointment = await prisma_1.prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, shipments: true },
    });
    if (!appointment)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, appointment.locationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const allowedOrders = new Set(appointment.orders.map((order) => order.orderNbr));
    const incoming = body.data.shipments;
    for (const entry of incoming) {
        if (!allowedOrders.has(entry.orderNbr)) {
            return res.status(400).json({ message: "Invalid order for appointment." });
        }
        const validation = validateShipmentNbrs(entry.shipmentNbrs);
        if (!validation.ok) {
            return res.status(400).json({
                message: "Invalid shipment number format.",
                shipmentNbr: validation.invalid,
            });
        }
    }
    const shipmentRows = incoming.flatMap((entry) => {
        const validation = validateShipmentNbrs(entry.shipmentNbrs);
        if (!validation.ok)
            return [];
        return validation.values.map((shipmentNbr) => ({
            appointmentId: appointment.id,
            orderNbr: entry.orderNbr,
            shipmentNbr,
            createdByUserId: req.auth?.id ?? null,
        }));
    });
    await prisma_1.prisma.$transaction(async (tx) => {
        const orderNbrs = incoming.map((entry) => entry.orderNbr);
        if (orderNbrs.length) {
            await tx.pickupAppointmentShipment.deleteMany({
                where: { appointmentId: appointment.id, orderNbr: { in: orderNbrs } },
            });
        }
        if (shipmentRows.length) {
            await tx.pickupAppointmentShipment.createMany({ data: shipmentRows });
        }
        const shipmentsByOrder = incoming.reduce((map, entry) => {
            map.set(entry.orderNbr, entry.shipmentNbrs.filter(Boolean));
            return map;
        }, new Map());
        const allShipped = appointment.orders.every((order) => (shipmentsByOrder.get(order.orderNbr) ?? []).length > 0);
        if (appointment.status === "Ready" && !allShipped) {
            await tx.pickupAppointment.update({
                where: { id: appointment.id },
                data: { status: "Scheduled" },
            });
        }
    });
    const updated = await prisma_1.prisma.pickupAppointment.findUnique({
        where: { id: appointment.id },
        include: { orders: true, shipments: true },
    });
    return res.json({
        pickup: {
            ...updated,
            locationId: updated
                ? (0, locationIds_1.normalizeLocationId)(updated.locationId) ?? updated.locationId
                : appointment.locationId,
        },
    });
});
/**
 * PATCH /api/staff/pickups/:id
 * Body: { status?, startAt?, endAt?, locationId?, customer fields?, orderNbrs? }
 */
exports.pickupsRouter.patch("/:id", async (req, res) => {
    if (!canModifyPickups(req)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const body = zod_1.z.object({
        status: STATUS.optional(),
        startAt: zod_1.z.string().datetime().optional(),
        endAt: zod_1.z.string().datetime().optional(),
        locationId: zod_1.z.string().optional(),
        customerFirstName: zod_1.z.string().optional(),
        customerLastName: zod_1.z.string().nullable().optional(),
        customerEmail: zod_1.z.string().email().optional(),
        customerPhone: zod_1.z.string().nullable().optional(),
        vehicleInfo: zod_1.z.string().nullable().optional(),
        customerNotes: zod_1.z.string().nullable().optional(),
        orderNbrs: zod_1.z.array(zod_1.z.string()).optional(),
        selectedItems: zod_1.z.array(selectedItemsSchema).optional(),
        notifyCustomer: zod_1.z.boolean().optional(),
        cancelReason: zod_1.z.string().optional(),
    }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ message: "Invalid request body" });
    const nextCustomerEmail = body.data.customerEmail?.toLowerCase();
    const existing = await prisma_1.prisma.pickupAppointment.findUnique({
        where: { id: req.params.id },
        include: { orders: true, lines: true },
    });
    if (!existing)
        return res.status(404).json({ message: "Not found" });
    if (!canAccessLocation(req, existing.locationId))
        return res.status(403).json({ message: "Forbidden" });
    const nextLocationId = body.data.locationId ? (0, locationIds_1.normalizeLocationId)(body.data.locationId) : undefined;
    if (nextLocationId && !canAccessLocation(req, nextLocationId)) {
        return res.status(403).json({ message: "Forbidden" });
    }
    const nextStartAt = body.data.startAt ? new Date(body.data.startAt) : existing.startAt;
    const nextEndAt = body.data.endAt ? new Date(body.data.endAt) : existing.endAt;
    const nextScheduleLocationId = nextLocationId ?? existing.locationId;
    const nextStatus = body.data.status ? body.data.status : existing.status;
    const scheduleChanged = Boolean((body.data.startAt && nextStartAt.getTime() !== existing.startAt.getTime()) ||
        (body.data.endAt && nextEndAt.getTime() !== existing.endAt.getTime()) ||
        (nextLocationId && nextScheduleLocationId !== existing.locationId));
    const activatingAppointment = Boolean(body.data.status &&
        ACTIVE_APPOINTMENT_STATUSES.includes(nextStatus) &&
        !ACTIVE_APPOINTMENT_STATUSES.includes(existing.status));
    if (body.data.startAt || body.data.endAt) {
        if (Number.isNaN(nextStartAt.getTime()) ||
            Number.isNaN(nextEndAt.getTime()) ||
            nextEndAt <= nextStartAt) {
            return res.status(400).json({ message: "Invalid appointment time range." });
        }
        if (nextStartAt.getSeconds() !== 0 ||
            nextStartAt.getMilliseconds() !== 0 ||
            nextStartAt.getMinutes() % SLOT_MINUTES !== 0) {
            return res.status(400).json({ message: "Start time must be on a 15-minute interval." });
        }
    }
    if ((scheduleChanged || activatingAppointment) && ACTIVE_APPOINTMENT_STATUSES.includes(nextStatus)) {
        const slotConflict = await prisma_1.prisma.pickupAppointment.findFirst({
            where: {
                id: { not: existing.id },
                locationId: nextScheduleLocationId,
                status: { in: ACTIVE_APPOINTMENT_STATUSES },
                startAt: { lt: nextEndAt },
                endAt: { gt: nextStartAt },
            },
            select: { id: true, startAt: true, endAt: true },
        });
        if (slotConflict) {
            return res.status(409).json({
                message: "Time slot no longer available.",
                code: "SLOT_UNAVAILABLE",
                conflict: {
                    appointmentId: slotConflict.id,
                    startAt: slotConflict.startAt,
                    endAt: slotConflict.endAt,
                },
            });
        }
        const manualBlockConflict = await findManualBlockConflict(prisma_1.prisma, nextScheduleLocationId, nextStartAt, nextEndAt);
        if (manualBlockConflict) {
            return res.status(409).json({
                message: "Time slot is manually blocked.",
                code: "SLOT_MANUALLY_BLOCKED",
                conflict: manualBlockConflict,
            });
        }
    }
    const nextOrderNbrs = body.data.orderNbrs ?? existing.orders.map((o) => o.orderNbr);
    if (body.data.orderNbrs) {
        const activeConflicts = await findActiveOrderConflicts(nextOrderNbrs, existing.id);
        if (activeConflicts.length) {
            const first = activeConflicts[0];
            return res.status(409).json({
                message: `Order ${first.orderNbr} already has an active pickup appointment scheduled for ${first.displayAt}.`,
                code: "ORDER_ALREADY_SCHEDULED",
                conflicts: activeConflicts,
            });
        }
    }
    const normalizedSelections = normalizeSelections(body.data.selectedItems, nextOrderNbrs);
    const invalidQty = await validateSelectedItemQty(normalizedSelections);
    if (invalidQty) {
        return res.status(400).json({
            message: "Selected quantity exceeds open quantity.",
            orderNbr: invalidQty.orderNbr,
            lineId: invalidQty.lineId,
            maxQty: invalidQty.maxQty,
        });
    }
    const updated = await prisma_1.prisma.$transaction(async (tx) => {
        if (body.data.orderNbrs) {
            await tx.pickupAppointmentOrder.deleteMany({ where: { appointmentId: existing.id } });
            const orderRows = body.data.orderNbrs.map((orderNbr) => ({
                appointmentId: existing.id,
                orderNbr,
            }));
            if (orderRows.length) {
                await tx.pickupAppointmentOrder.createMany({ data: orderRows, skipDuplicates: true });
            }
            await tx.pickupAppointmentLine.deleteMany({
                where: {
                    appointmentId: existing.id,
                    orderNbr: { notIn: body.data.orderNbrs },
                },
            });
        }
        if (body.data.selectedItems) {
            await tx.pickupAppointmentLine.deleteMany({ where: { appointmentId: existing.id } });
            const lineRows = normalizedSelections.flatMap((selection) => selection.items.map((item) => ({
                appointmentId: existing.id,
                orderNbr: selection.orderNbr,
                lineId: item.lineId ?? null,
                inventoryId: item.inventoryId,
                qtySelected: item.qty,
                lineDescription: item.description ?? null,
            })));
            if (lineRows.length) {
                await tx.pickupAppointmentLine.createMany({ data: lineRows });
            }
        }
        return tx.pickupAppointment.update({
            where: { id: req.params.id },
            data: {
                status: body.data.status ? body.data.status : undefined,
                startAt: body.data.startAt ? new Date(body.data.startAt) : undefined,
                endAt: body.data.endAt ? new Date(body.data.endAt) : undefined,
                locationId: nextLocationId ?? undefined,
                customerFirstName: body.data.customerFirstName,
                customerLastName: body.data.customerLastName ?? undefined,
                customerEmail: nextCustomerEmail ?? undefined,
                email: nextCustomerEmail ?? undefined,
                customerPhone: body.data.customerPhone ?? undefined,
                vehicleInfo: body.data.vehicleInfo ?? undefined,
                customerNotes: body.data.customerNotes ?? undefined,
            },
            include: { orders: true },
        });
    });
    const notifyCustomer = body.data.notifyCustomer ?? false;
    const cancelReason = body.data.cancelReason ?? null;
    const effectiveOrderNbrs = nextOrderNbrs;
    const timeChanged = (body.data.startAt && new Date(body.data.startAt).getTime() !== existing.startAt.getTime()) ||
        (body.data.endAt && new Date(body.data.endAt).getTime() !== existing.endAt.getTime());
    const locationChanged = body.data.locationId &&
        ((0, locationIds_1.normalizeLocationId)(body.data.locationId) ?? body.data.locationId) !== existing.locationId;
    const statusChanged = body.data.status && body.data.status !== existing.status;
    const terminalStatusChange = statusChanged &&
        (body.data.status === "Cancelled" ||
            body.data.status === "Completed" ||
            body.data.status === "NoShow");
    const orderListChanged = Array.isArray(body.data.orderNbrs) &&
        (body.data.orderNbrs.length !== existing.orders.length ||
            body.data.orderNbrs.some((orderNbr) => !existing.orders.some((o) => o.orderNbr === orderNbr)));
    const existingSelections = Array.from(existing.lines.reduce((map, line) => {
        const entry = map.get(line.orderNbr) ?? [];
        entry.push({
            lineId: line.lineId ?? undefined,
            inventoryId: line.inventoryId,
            qty: Number(line.qtySelected),
        });
        map.set(line.orderNbr, entry);
        return map;
    }, new Map())).map(([orderNbr, items]) => ({ orderNbr, items }));
    const itemsChanged = Array.isArray(body.data.selectedItems)
        ? !areSelectedItemsEqual(existingSelections, normalizedSelections)
        : false;
    try {
        if (!terminalStatusChange && (timeChanged || locationChanged)) {
            if (notifyCustomer) {
                await (0, notifications_1.notifyAppointmentRescheduled)(prisma_1.prisma, updated, effectiveOrderNbrs, existing.startAt, existing.endAt, notifyCustomer, true, true);
            }
            else {
                await (0, notifications_1.cancelAppointmentNotifications)(prisma_1.prisma, updated.id);
            }
            if (updated.status === "Ready") {
                await (0, notifications_1.notifyAppointmentReady)(prisma_1.prisma, updated, effectiveOrderNbrs, true, true, true);
            }
        }
        if (statusChanged && body.data.status === "Completed") {
            await (0, notifications_1.notifyAppointmentCompleted)(prisma_1.prisma, updated, effectiveOrderNbrs, notifyCustomer, true, true);
        }
        if (statusChanged && body.data.status === "Ready") {
            await (0, notifications_1.notifyAppointmentReady)(prisma_1.prisma, updated, effectiveOrderNbrs, notifyCustomer, true, true);
        }
        if (statusChanged && body.data.status === "Cancelled") {
            await (0, notifications_1.cancelAppointmentNotifications)(prisma_1.prisma, updated.id);
            await (0, notifications_1.notifyStaffCancelled)(prisma_1.prisma, updated, effectiveOrderNbrs, cancelReason, notifyCustomer);
        }
        if (statusChanged && body.data.status === "NoShow") {
            await (0, notifications_1.cancelAppointmentNotifications)(prisma_1.prisma, updated.id);
        }
        if (orderListChanged || itemsChanged) {
            await (0, notifications_1.notifyOrderListChanged)(prisma_1.prisma, updated, effectiveOrderNbrs, notifyCustomer, true, true);
        }
    }
    catch (err) {
        console.error("[notifications] staff update failed", err);
    }
    return res.json({
        pickup: {
            ...updated,
            locationId: (0, locationIds_1.normalizeLocationId)(updated.locationId) ?? updated.locationId,
        },
    });
});
