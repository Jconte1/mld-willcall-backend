import assert from "node:assert/strict";
import { denverDateKey, denverDateRangeUtc } from "../src/lib/time/denver";
import { getAutomaticNoShowWindow } from "../src/notifications/appointments/runNoShowSweep";
import { isValidOrderReadyEmail } from "../src/notifications/orderReady/runOrderReadySync";
import { isSuccessfulOrderReadySyncForBusinessDate } from "../src/notifications/orderReady/syncState";

process.env.TZ = "UTC";

function iso(date: Date) {
  return date.toISOString();
}

function eligibleForAutomaticNoShow(endAt: Date, now: Date) {
  const window = getAutomaticNoShowWindow(now);
  return (
    endAt < now &&
    ((endAt >= window.todayRange.start && endAt < window.todayRange.end) ||
      (endAt >= window.yesterdayRange.start && endAt < window.yesterdayRange.end))
  );
}

function simulateOrderReadyDataSync(input: {
  reportOrders: { orderNbr: string; email: string | null; emailOptIn: boolean }[];
  existingOrders: { orderNbr: string; status: string; notifyAttemptCount: number }[];
}) {
  const seen = new Set(input.reportOrders.map((order) => order.orderNbr));
  const sendFailures: string[] = [];
  const notices = new Map(input.existingOrders.map((order) => [order.orderNbr, { ...order }]));

  for (const row of input.reportOrders) {
    const existing = notices.get(row.orderNbr);
    notices.set(row.orderNbr, {
      orderNbr: row.orderNbr,
      status: "Open",
      notifyAttemptCount: existing?.notifyAttemptCount ?? 0,
    });

    if (row.emailOptIn && row.email && !isValidOrderReadyEmail(row.email)) {
      sendFailures.push(row.orderNbr);
      continue;
    }
  }

  for (const notice of notices.values()) {
    if (!seen.has(notice.orderNbr)) {
      notice.status = "NotReady";
      notice.notifyAttemptCount = 0;
    }
  }

  return {
    dataSyncSucceeded: true,
    sendFailures,
    notices: Array.from(notices.values()),
  };
}

function main() {
  assert.equal(isValidOrderReadyEmail("valid@example.com"), true);
  assert.equal(isValidOrderReadyEmail("mckenzie@beaverconstructionut/com"), false);
  assert.equal(isValidOrderReadyEmail("missing-at.example.com"), false);

  const businessDate = "2026-08-25";
  assert.equal(
    isSuccessfulOrderReadySyncForBusinessDate(
      { businessDate, status: "success", completedAt: new Date("2026-08-25T15:31:00Z") },
      businessDate
    ),
    true
  );
  assert.equal(
    isSuccessfulOrderReadySyncForBusinessDate(
      { businessDate: "2026-08-24", status: "success", completedAt: new Date("2026-08-24T15:31:00Z") },
      businessDate
    ),
    false
  );
  assert.equal(
    isSuccessfulOrderReadySyncForBusinessDate(
      { businessDate, status: "failed", completedAt: new Date("2026-08-25T15:31:00Z") },
      businessDate
    ),
    false
  );
  assert.equal(
    isSuccessfulOrderReadySyncForBusinessDate(
      { businessDate, status: "success", completedAt: null },
      businessDate
    ),
    false
  );

  const simulated = simulateOrderReadyDataSync({
    reportOrders: [
      { orderNbr: "GOOD001", email: "customer@example.com", emailOptIn: true },
      { orderNbr: "BAD001", email: "mckenzie@beaverconstructionut/com", emailOptIn: true },
    ],
    existingOrders: [
      { orderNbr: "HW06415", status: "On Hold but Approved", notifyAttemptCount: 6 },
      { orderNbr: "GOOD001", status: "Open", notifyAttemptCount: 1 },
    ],
  });
  assert.equal(simulated.dataSyncSucceeded, true);
  assert.deepEqual(simulated.sendFailures, ["BAD001"]);
  assert.deepEqual(
    simulated.notices.find((notice) => notice.orderNbr === "HW06415"),
    { orderNbr: "HW06415", status: "NotReady", notifyAttemptCount: 0 }
  );

  assert.equal(denverDateKey(new Date("2026-08-25T14:42:00Z")), "2026-08-25");
  assert.equal(iso(denverDateRangeUtc("2026-08-25").start), "2026-08-25T06:00:00.000Z");
  assert.equal(iso(denverDateRangeUtc("2026-01-15").start), "2026-01-15T07:00:00.000Z");
  assert.equal(iso(denverDateRangeUtc("2026-03-08").start), "2026-03-08T07:00:00.000Z");
  assert.equal(iso(denverDateRangeUtc("2026-03-08").end), "2026-03-09T06:00:00.000Z");
  assert.equal(iso(denverDateRangeUtc("2026-11-01").start), "2026-11-01T06:00:00.000Z");
  assert.equal(iso(denverDateRangeUtc("2026-11-01").end), "2026-11-02T07:00:00.000Z");

  const now = new Date("2026-08-25T23:20:00Z");
  assert.equal(eligibleForAutomaticNoShow(new Date("2026-08-25T20:00:00Z"), now), true);
  assert.equal(eligibleForAutomaticNoShow(new Date("2026-08-25T23:45:00Z"), now), false);
  assert.equal(eligibleForAutomaticNoShow(new Date("2026-08-24T20:00:00Z"), now), true);
  assert.equal(eligibleForAutomaticNoShow(new Date("2026-08-23T20:00:00Z"), now), false);

  console.log("notification reliability validation passed");
}

main();
