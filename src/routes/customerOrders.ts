import { Router } from "express";
import { z } from "zod";
import { getCustomerOrders } from "../lib/orders/getCustomerOrders";
import { getCustomerOrderDetail } from "../lib/orders/getCustomerOrderDetail";
import { resolveSingleBaid } from "../lib/acumatica/resolveBaid";

export const customerOrdersRouter = Router();

const ORDERS_BODY = z.object({
  userId: z.string().optional(),
  email: z.string().email().optional(),
  baid: z.string().optional(),
});

const ORDER_DETAIL_BODY = z.object({
  orderNbr: z.string().min(1),
  userId: z.string().optional(),
  email: z.string().email().optional(),
  baid: z.string().optional(),
});

customerOrdersRouter.post("/", async (req, res) => {
  const parsed = ORDERS_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  console.log("[customer-orders] request", {
    userId: parsed.data.userId,
    email: parsed.data.email,
    baid: parsed.data.baid,
  });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    console.warn("[customer-orders] resolve baid failed", {
      userId: parsed.data.userId,
      email: parsed.data.email,
      baid: parsed.data.baid,
      error: String(err?.message || err),
    });
    return res.status(400).json({ message: String(err?.message || err) });
  }

  console.log("[customer-orders] resolved baid", { baid });
  const orders = await getCustomerOrders(baid);
  return res.json({ orders });
});

customerOrdersRouter.post("/detail", async (req, res) => {
  const parsed = ORDER_DETAIL_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    return res.status(400).json({ message: String(err?.message || err) });
  }

  const detail = await getCustomerOrderDetail(baid, parsed.data.orderNbr);
  if (!detail) return res.status(404).json({ message: "Order not found" });

  return res.json(detail);
});
