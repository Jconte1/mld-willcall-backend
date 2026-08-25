import { PrismaClient } from "@prisma/client";
import { denverDateKey } from "../../lib/time/denver";

export const ORDER_READY_SYNC_JOB_NAME = "order-ready-daily";

const SUCCESS_STATUS = "success";
const FAILED_STATUS = "failed";
const RUNNING_STATUS = "running";
const SKIPPED_STATUS = "skipped";

function summarizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export function getOrderReadyBusinessDate(now = new Date()) {
  return denverDateKey(now);
}

export function isSuccessfulOrderReadySyncForBusinessDate(
  state: { businessDate: string | null; completedAt: Date | null; status: string | null } | null,
  businessDate: string
) {
  return state?.businessDate === businessDate && state.status === SUCCESS_STATUS && Boolean(state.completedAt);
}

export async function markOrderReadySyncStarted(prisma: PrismaClient, now = new Date()) {
  await prisma.orderReadyJobState.upsert({
    where: { name: ORDER_READY_SYNC_JOB_NAME },
    update: {
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: null,
      status: RUNNING_STATUS,
      rowCount: null,
      orderCount: null,
      errorSummary: null,
    },
    create: {
      name: ORDER_READY_SYNC_JOB_NAME,
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      status: RUNNING_STATUS,
      lastRunAt: null,
    },
  });
}

export async function markOrderReadySyncSucceeded(
  prisma: PrismaClient,
  input: { startedAt: Date; completedAt?: Date; rowCount: number; orderCount: number }
) {
  const completedAt = input.completedAt ?? new Date();
  await prisma.orderReadyJobState.upsert({
    where: { name: ORDER_READY_SYNC_JOB_NAME },
    update: {
      lastRunAt: completedAt,
      businessDate: getOrderReadyBusinessDate(input.startedAt),
      startedAt: input.startedAt,
      completedAt,
      status: SUCCESS_STATUS,
      rowCount: input.rowCount,
      orderCount: input.orderCount,
      errorSummary: null,
    },
    create: {
      name: ORDER_READY_SYNC_JOB_NAME,
      lastRunAt: completedAt,
      businessDate: getOrderReadyBusinessDate(input.startedAt),
      startedAt: input.startedAt,
      completedAt,
      status: SUCCESS_STATUS,
      rowCount: input.rowCount,
      orderCount: input.orderCount,
    },
  });
}

export async function markOrderReadySyncFailed(
  prisma: PrismaClient,
  input: { startedAt: Date; error: unknown }
) {
  const completedAt = new Date();
  await prisma.orderReadyJobState.upsert({
    where: { name: ORDER_READY_SYNC_JOB_NAME },
    update: {
      businessDate: getOrderReadyBusinessDate(input.startedAt),
      startedAt: input.startedAt,
      completedAt,
      status: FAILED_STATUS,
      errorSummary: summarizeError(input.error),
    },
    create: {
      name: ORDER_READY_SYNC_JOB_NAME,
      businessDate: getOrderReadyBusinessDate(input.startedAt),
      startedAt: input.startedAt,
      completedAt,
      status: FAILED_STATUS,
      errorSummary: summarizeError(input.error),
    },
  });
}

export async function markOrderReadySyncSkipped(
  prisma: PrismaClient,
  reason: string,
  now = new Date()
) {
  await prisma.orderReadyJobState.upsert({
    where: { name: ORDER_READY_SYNC_JOB_NAME },
    update: {
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: now,
      status: SKIPPED_STATUS,
      errorSummary: reason,
    },
    create: {
      name: ORDER_READY_SYNC_JOB_NAME,
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: now,
      status: SKIPPED_STATUS,
      errorSummary: reason,
    },
  });
}

export async function hasSuccessfulOrderReadySyncForToday(
  prisma: PrismaClient,
  now = new Date()
) {
  const state = await prisma.orderReadyJobState.findUnique({
    where: { name: ORDER_READY_SYNC_JOB_NAME },
    select: {
      businessDate: true,
      completedAt: true,
      status: true,
      rowCount: true,
      orderCount: true,
      errorSummary: true,
      lastRunAt: true,
    },
  });
  const businessDate = getOrderReadyBusinessDate(now);
  const ok = isSuccessfulOrderReadySyncForBusinessDate(state, businessDate);

  return { ok, businessDate, state };
}
