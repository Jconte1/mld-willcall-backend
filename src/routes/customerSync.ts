import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { resolveSingleBaid } from "../lib/acumatica/resolveBaid";
import { runCustomerDeltaSync } from "../lib/acumatica/sync/syncCustomerAccount";
import { ingestPaymentInfo } from "../lib/acumatica/ingest/ingestPaymentInfo";
import { toDenverDateTimeOffsetLiteralAt } from "../lib/time/denver";

const prisma = new PrismaClient();

export const customerSyncRouter = Router();

const SYNC_BODY = z.object({
  userId: z.string().optional(),
  email: z.string().email().optional(),
  baid: z.string().optional(),
  force: z.boolean().optional(),
});

const STALE_MS = 60 * 60 * 1000;
const PAYMENT_STALE_MS = Number(process.env.PAYMENT_STALE_MS || 10 * 60 * 1000);
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const IN_PROGRESS_GRACE_MS = 20 * 60 * 1000;
const FORCE_COOLDOWN_MS = Number(process.env.CUSTOMER_SYNC_FORCE_COOLDOWN_MS || 2 * 60 * 1000);

const paymentInFlight = new Map<string, Promise<{ ok: boolean; error?: string }>>();

async function refreshPaymentsIfStale(baid: string) {
  const latest = await prisma.erpOrderPayment.findFirst({
    where: { baid },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const lastPaymentAt = latest?.updatedAt ?? null;
  const age = lastPaymentAt ? Date.now() - new Date(lastPaymentAt).getTime() : Infinity;
  if (age < PAYMENT_STALE_MS) {
    return { status: "payment-fresh", lastPaymentAt };
  }

  if (paymentInFlight.has(baid)) {
    await paymentInFlight.get(baid);
    return { status: "payment-in-progress", lastPaymentAt };
  }

  const promise: Promise<{ ok: boolean; error?: string }> = ingestPaymentInfo(baid)
    .then(() => ({ ok: true }))
    .catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
  paymentInFlight.set(baid, promise);
  const result = await promise;
  paymentInFlight.delete(baid);

  if (!result.ok) {
    return { status: "payment-failed", lastPaymentAt, error: result.error };
  }
  return { status: "payment-refreshed", lastPaymentAt: new Date() };
}

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
  const force = Boolean(parsed.data.force);
  console.log("[customer-sync] request", {
    baid,
    hasState: Boolean(existing),
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
    lastErrorAt: existing?.lastErrorAt ?? null,
    inProgress: Boolean(existing?.inProgress),
    force,
  });

  if (existing?.inProgress && existing.inProgressSince) {
    const age = now.getTime() - new Date(existing.inProgressSince).getTime();
    if (age < IN_PROGRESS_GRACE_MS) {
      console.log("[customer-sync] skip (in-progress)", { baid, ageMs: age });
      return res.json({
        status: "in-progress",
        lastSyncAt: existing.lastSyncAt,
        lastErrorAt: existing.lastErrorAt,
      });
    }
  }

  if (force && existing?.lastAttemptAt) {
    const age = now.getTime() - new Date(existing.lastAttemptAt).getTime();
    if (age < FORCE_COOLDOWN_MS) {
      console.log("[customer-sync] skip (force cooldown)", { baid, ageMs: age });
      return res.json({
        status: "cooldown",
        lastSyncAt: existing.lastSyncAt,
        lastAttemptAt: existing.lastAttemptAt,
      });
    }
  }

  if (existing?.lastSyncAt) {
    const age = now.getTime() - new Date(existing.lastSyncAt).getTime();
    if (age < STALE_MS && !force) {
      console.log("[customer-sync] skip (fresh)", { baid, ageMs: age });
      const paymentRefresh = await refreshPaymentsIfStale(baid);
      return res.json({
        status: "fresh",
        lastSyncAt: existing.lastSyncAt,
        paymentRefresh,
      });
    }
  }

  if (existing?.lastErrorAt) {
    const age = now.getTime() - new Date(existing.lastErrorAt).getTime();
    if (age < FAILURE_BACKOFF_MS && !force) {
      console.log("[customer-sync] skip (backoff)", { baid, ageMs: age });
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
    console.log("[customer-sync] run", { baid });
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
