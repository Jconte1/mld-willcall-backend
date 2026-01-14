"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const runPendingJobs_1 = require("./jobs/runPendingJobs");
const prisma = new client_1.PrismaClient();
const intervalMs = Number(process.env.NOTIFICATIONS_WORKER_INTERVAL_MS || 60000);
async function tick() {
    try {
        await (0, runPendingJobs_1.runPendingJobs)(prisma);
    }
    catch (err) {
        console.error("[notifications-worker] error", err);
    }
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
