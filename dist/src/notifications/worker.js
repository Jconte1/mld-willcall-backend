"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = require("../lib/prisma");
const runPendingJobs_1 = require("./jobs/runPendingJobs");
const runNoShowSweep_1 = require("./appointments/runNoShowSweep");
const runOrderReadySync_1 = require("./orderReady/runOrderReadySync");
const runOrderReadyEscalations_1 = require("./orderReady/runOrderReadyEscalations");
const intervalMs = Number(process.env.NOTIFICATIONS_WORKER_INTERVAL_MS || 60000);
async function runWorkerStep(name, fn) {
    try {
        await fn();
    }
    catch (err) {
        console.error("[notifications-worker] step error", {
            step: name,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
async function tick() {
    await runWorkerStep("order-ready-sync", () => (0, runOrderReadySync_1.runOrderReadySync)(prisma_1.prisma));
    await runWorkerStep("order-ready-escalations", () => (0, runOrderReadyEscalations_1.runOrderReadyEscalations)(prisma_1.prisma));
    await runWorkerStep("no-show-sweep", () => (0, runNoShowSweep_1.runNoShowSweep)(prisma_1.prisma));
    await runWorkerStep("pending-jobs", () => (0, runPendingJobs_1.runPendingJobs)(prisma_1.prisma));
}
async function main() {
    while (true) {
        await tick();
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
main().catch((err) => {
    console.error("[notifications-worker] fatal", err);
    process.exit(1);
});
