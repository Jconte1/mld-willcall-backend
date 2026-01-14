"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customerOrdersRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const getCustomerOrders_1 = require("../lib/orders/getCustomerOrders");
const getCustomerOrderDetail_1 = require("../lib/orders/getCustomerOrderDetail");
const resolveBaid_1 = require("../lib/acumatica/resolveBaid");
exports.customerOrdersRouter = (0, express_1.Router)();
const ORDERS_BODY = zod_1.z.object({
    userId: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    baid: zod_1.z.string().optional(),
});
const ORDER_DETAIL_BODY = zod_1.z.object({
    orderNbr: zod_1.z.string().min(1),
    userId: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    baid: zod_1.z.string().optional(),
});
exports.customerOrdersRouter.post("/", async (req, res) => {
    const parsed = ORDERS_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    console.log("[customer-orders] request", {
        userId: parsed.data.userId,
        email: parsed.data.email,
        baid: parsed.data.baid,
    });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        console.warn("[customer-orders] resolve baid failed", {
            userId: parsed.data.userId,
            email: parsed.data.email,
            baid: parsed.data.baid,
            error: String(err?.message || err),
        });
        return res.status(400).json({ message: String(err?.message || err) });
    }
    console.log("[customer-orders] resolved baid", { baid });
    const orders = await (0, getCustomerOrders_1.getCustomerOrders)(baid);
    return res.json({ orders });
});
exports.customerOrdersRouter.post("/detail", async (req, res) => {
    const parsed = ORDER_DETAIL_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        return res.status(400).json({ message: String(err?.message || err) });
    }
    const detail = await (0, getCustomerOrderDetail_1.getCustomerOrderDetail)(baid, parsed.data.orderNbr);
    if (!detail)
        return res.status(404).json({ message: "Order not found" });
    return res.json(detail);
});
