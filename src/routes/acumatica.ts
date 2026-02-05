import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { runOneTimeSync, OneTimeSyncKey } from "../lib/acumatica/oneTimeSync";
import { resolveSingleBaid } from "../lib/acumatica/resolveBaid";
import { ingestOrderSummaries } from "../lib/acumatica/ingest/ingestOrderSummaries";
import { ingestPaymentInfo } from "../lib/acumatica/ingest/ingestPaymentInfo";
import { ingestInventoryDetails } from "../lib/acumatica/ingest/ingestInventoryDetails";
import { ingestAddressContact } from "../lib/acumatica/ingest/ingestAddressContact";

export const acumaticaRouter = Router();
const prisma = new PrismaClient();

const SYNC_KEYS: OneTimeSyncKey[] = [
  "order-summaries",
  "payment-info",
  "inventory-details",
  "address-contact",
];

const ONE_TIME_SYNC_BODY = z.object({
  userId: z.string().optional(),
  email: z.string().email(),
  baid: z.string().min(1),
  run: z.array(z.enum(SYNC_KEYS as [OneTimeSyncKey, ...OneTimeSyncKey[]])).optional(),
});

const INGEST_BODY = z.object({
  userId: z.string().optional(),
  email: z.string().email().optional(),
  baid: z.string().optional(),
});

acumaticaRouter.post("/one-time-sync", async (req, res) => {
  const parsed = ONE_TIME_SYNC_BODY.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const result = await runOneTimeSync({
    userId: parsed.data.userId ?? null,
    email: parsed.data.email ?? null,
    baid: parsed.data.baid,
    run: parsed.data.run,
  });

  const allOk = Array.isArray(result?.results)
    ? result.results.every((r) => r?.ok === true)
    : true;
  if (allOk) {
    const now = new Date();
    await prisma.baidSyncState.upsert({
      where: { baid: parsed.data.baid },
      create: {
        baid: parsed.data.baid,
        inProgress: false,
        inProgressSince: null,
        lastAttemptAt: now,
        lastSyncAt: now,
        lastSuccessAt: now,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
      update: {
        inProgress: false,
        inProgressSince: null,
        lastAttemptAt: now,
        lastSyncAt: now,
        lastSuccessAt: now,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
  }

  return res.json(result);
});

acumaticaRouter.post("/ingest-order-summaries", async (req, res) => {
  const parsed = INGEST_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    return res.status(400).json({ message: String(err?.message || err) });
  }

  const result = await ingestOrderSummaries(baid);
  return res.json(result);
});

acumaticaRouter.post("/ingest-payment-info", async (req, res) => {
  const parsed = INGEST_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    return res.status(400).json({ message: String(err?.message || err) });
  }

  const result = await ingestPaymentInfo(baid);
  return res.json(result);
});

acumaticaRouter.post("/ingest-inventory-details", async (req, res) => {
  const parsed = INGEST_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    return res.status(400).json({ message: String(err?.message || err) });
  }

  const result = await ingestInventoryDetails(baid);
  return res.json(result);
});

acumaticaRouter.post("/ingest-address-contact", async (req, res) => {
  const parsed = INGEST_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    return res.status(400).json({ message: String(err?.message || err) });
  }

  const result = await ingestAddressContact(baid);
  return res.json(result);
});
