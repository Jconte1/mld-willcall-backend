"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customerOrdersRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const getCustomerOrders_1 = require("../lib/orders/getCustomerOrders");
const resolveBaid_1 = require("../lib/acumatica/resolveBaid");
exports.customerOrdersRouter = (0, express_1.Router)();
const ORDERS_BODY = zod_1.z.object({
    userId: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    baid: zod_1.z.string().optional(),
});
exports.customerOrdersRouter.post("/", async (req, res) => {
    const parsed = ORDERS_BODY.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Invalid request body" });
    let baid;
    try {
        baid = await (0, resolveBaid_1.resolveSingleBaid)(parsed.data);
    }
    catch (err) {
        return res.status(400).json({ message: String(err?.message || err) });
    }
    const orders = await (0, getCustomerOrders_1.getCustomerOrders)(baid);
    return res.json({ orders });
});
