"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORDER_READY_SYNC_JOB_NAME = void 0;
exports.getOrderReadyBusinessDate = getOrderReadyBusinessDate;
exports.isSuccessfulOrderReadySyncForBusinessDate = isSuccessfulOrderReadySyncForBusinessDate;
exports.markOrderReadySyncStarted = markOrderReadySyncStarted;
exports.markOrderReadySyncSucceeded = markOrderReadySyncSucceeded;
exports.markOrderReadySyncFailed = markOrderReadySyncFailed;
exports.markOrderReadySyncSkipped = markOrderReadySyncSkipped;
exports.hasSuccessfulOrderReadySyncForToday = hasSuccessfulOrderReadySyncForToday;
const denver_1 = require("../../lib/time/denver");
exports.ORDER_READY_SYNC_JOB_NAME = "order-ready-daily";
const SUCCESS_STATUS = "success";
const FAILED_STATUS = "failed";
const RUNNING_STATUS = "running";
const SKIPPED_STATUS = "skipped";
function summarizeError(error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}
function getOrderReadyBusinessDate(now = new Date()) {
    return (0, denver_1.denverDateKey)(now);
}
function isSuccessfulOrderReadySyncForBusinessDate(state, businessDate) {
    return state?.businessDate === businessDate && state.status === SUCCESS_STATUS && Boolean(state.completedAt);
}
async function markOrderReadySyncStarted(prisma, now = new Date()) {
    await prisma.orderReadyJobState.upsert({
        where: { name: exports.ORDER_READY_SYNC_JOB_NAME },
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
            name: exports.ORDER_READY_SYNC_JOB_NAME,
            businessDate: getOrderReadyBusinessDate(now),
            startedAt: now,
            status: RUNNING_STATUS,
            lastRunAt: null,
        },
    });
}
async function markOrderReadySyncSucceeded(prisma, input) {
    const completedAt = input.completedAt ?? new Date();
    await prisma.orderReadyJobState.upsert({
        where: { name: exports.ORDER_READY_SYNC_JOB_NAME },
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
            name: exports.ORDER_READY_SYNC_JOB_NAME,
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
async function markOrderReadySyncFailed(prisma, input) {
    const completedAt = new Date();
    await prisma.orderReadyJobState.upsert({
        where: { name: exports.ORDER_READY_SYNC_JOB_NAME },
        update: {
            businessDate: getOrderReadyBusinessDate(input.startedAt),
            startedAt: input.startedAt,
            completedAt,
            status: FAILED_STATUS,
            errorSummary: summarizeError(input.error),
        },
        create: {
            name: exports.ORDER_READY_SYNC_JOB_NAME,
            businessDate: getOrderReadyBusinessDate(input.startedAt),
            startedAt: input.startedAt,
            completedAt,
            status: FAILED_STATUS,
            errorSummary: summarizeError(input.error),
        },
    });
}
async function markOrderReadySyncSkipped(prisma, reason, now = new Date()) {
    await prisma.orderReadyJobState.upsert({
        where: { name: exports.ORDER_READY_SYNC_JOB_NAME },
        update: {
            businessDate: getOrderReadyBusinessDate(now),
            startedAt: now,
            completedAt: now,
            status: SKIPPED_STATUS,
            errorSummary: reason,
        },
        create: {
            name: exports.ORDER_READY_SYNC_JOB_NAME,
            businessDate: getOrderReadyBusinessDate(now),
            startedAt: now,
            completedAt: now,
            status: SKIPPED_STATUS,
            errorSummary: reason,
        },
    });
}
async function hasSuccessfulOrderReadySyncForToday(prisma, now = new Date()) {
    const state = await prisma.orderReadyJobState.findUnique({
        where: { name: exports.ORDER_READY_SYNC_JOB_NAME },
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
