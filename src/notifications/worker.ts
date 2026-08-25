import { prisma } from "../lib/prisma";

import { runPendingJobs } from "./jobs/runPendingJobs";
import { runNoShowSweep } from "./appointments/runNoShowSweep";
import { runOrderReadySync } from "./orderReady/runOrderReadySync";
import { runOrderReadyEscalations } from "./orderReady/runOrderReadyEscalations";

const intervalMs = Number(process.env.NOTIFICATIONS_WORKER_INTERVAL_MS || 60000);

async function runWorkerStep(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    console.error("[notifications-worker] step error", {
      step: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function tick() {
  await runWorkerStep("order-ready-sync", () => runOrderReadySync(prisma));
  await runWorkerStep("order-ready-escalations", () => runOrderReadyEscalations(prisma));
  await runWorkerStep("no-show-sweep", () => runNoShowSweep(prisma));
  await runWorkerStep("pending-jobs", () => runPendingJobs(prisma));
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
