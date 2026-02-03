import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { resolveSingleBaid } from "../lib/acumatica/resolveBaid";
import { runCustomerDeltaSync } from "../lib/acumatica/sync/syncCustomerAccount";
import { toDenverDateTimeOffsetLiteralAt } from "../lib/time/denver";

const prisma = new PrismaClient();

export const customerSyncRouter = Router();

const SYNC_BODY = z.object({
  userId: z.string().optional(),
  email: z.string().email().optional(),
  baid: z.string().optional(),
});

const STALE_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const IN_PROGRESS_GRACE_MS = 20 * 60 * 1000;

customerSyncRouter.post("/", async (req, res) => {
  const parsed = SYNC_BODY.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid request body" });

  let baid: string;
  try {
    baid = await resolveSingleBaid(parsed.data);
  } catch (err: any) {
    return res.status(400).json({ message: String(err?.message || err) });
  }

  const now = new Date();
  const existing = await prisma.baidSyncState.findUnique({ where: { baid } });
  console.log("[customer-sync] request", {
    baid,
    hasState: Boolean(existing),
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
    lastErrorAt: existing?.lastErrorAt ?? null,
    inProgress: Boolean(existing?.inProgress),
  });

  if (existing?.inProgress && existing.inProgressSince) {
    const age = now.getTime() - new Date(existing.inProgressSince).getTime();
    if (age < IN_PROGRESS_GRACE_MS) {
      console.log("[customer-sync] skip (in-progress)", { baid, ageMs: age, source: "db" });
      return res.json({
        status: "in-progress",
        lastSyncAt: existing.lastSyncAt,
        lastErrorAt: existing.lastErrorAt,
      });
    }
  }

  if (existing?.lastSyncAt) {
    const age = now.getTime() - new Date(existing.lastSyncAt).getTime();
    if (age < STALE_MS) {
      console.log("[customer-sync] skip (fresh)", { baid, ageMs: age, source: "db" });
      return res.json({ status: "fresh", lastSyncAt: existing.lastSyncAt });
    }
  }

  if (existing?.lastErrorAt) {
    const age = now.getTime() - new Date(existing.lastErrorAt).getTime();
    if (age < FAILURE_BACKOFF_MS) {
      console.log("[customer-sync] skip (backoff)", { baid, ageMs: age, source: "db" });
      return res.json({
        status: "backoff",
        lastSyncAt: existing.lastSyncAt,
        lastErrorAt: existing.lastErrorAt,
        lastErrorMessage: existing.lastErrorMessage,
      });
    }
  }

  await prisma.baidSyncState.upsert({
    where: { baid },
    create: {
      baid,
      inProgress: true,
      inProgressSince: now,
      lastAttemptAt: now,
    },
    update: {
      inProgress: true,
      inProgressSince: now,
      lastAttemptAt: now,
    },
  });

  try {
    const sinceLiteral = existing?.lastSyncAt
      ? toDenverDateTimeOffsetLiteralAt(existing.lastSyncAt)
      : undefined;
    console.log("[customer-sync] run", { baid, source: "acumatica" });
    const result = await runCustomerDeltaSync(baid, { sinceLiteral });
    const finishedAt = new Date();
    await prisma.baidSyncState.update({
      where: { baid },
      data: {
        inProgress: false,
        inProgressSince: null,
        lastSyncAt: finishedAt,
        lastSuccessAt: finishedAt,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });

    console.log("[customer-sync] success", {
      baid,
      fetchedHeaders: result.fetchedHeaders,
      keptHeaders: result.keptHeaders,
      orderNbrs: result.details.orderNbrs,
      addressRows: result.details.addressRows,
      paymentRows: result.details.paymentRows,
      inventoryRows: result.details.inventoryRows,
    });
    return res.json({
      status: "synced",
      lastSyncAt: finishedAt,
      result,
    });
  } catch (err: any) {
    const message = String(err?.message || err);
    const failedAt = new Date();
    await prisma.baidSyncState.update({
      where: { baid },
      data: {
        inProgress: false,
        inProgressSince: null,
        lastErrorAt: failedAt,
        lastErrorMessage: message,
      },
    });

    console.warn("[customer-sync] failed", { baid, error: message });
    return res.json({
      status: "failed",
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastErrorAt: failedAt,
      lastErrorMessage: message,
    });
  }
});
