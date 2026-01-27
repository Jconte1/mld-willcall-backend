import { PrismaClient } from "@prisma/client";
import { runPendingJobs } from "./jobs/runPendingJobs";
import { runNoShowSweep } from "./appointments/runNoShowSweep";
import { runOrderReadySync } from "./orderReady/runOrderReadySync";

const prisma = new PrismaClient();
const intervalMs = Number(process.env.NOTIFICATIONS_WORKER_INTERVAL_MS || 60000);

async function tick() {
  try {
    await runOrderReadySync(prisma);
    await runNoShowSweep(prisma);
    await runPendingJobs(prisma);
  } catch (err) {
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
