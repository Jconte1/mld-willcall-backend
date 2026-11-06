// Real booking/availability handlers with an in-memory database and blocked ERP/notification calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("ts-node").register({ transpileOnly: true });
const root = path.resolve(__dirname, "..");
const { findRecurringPickupBlock, getRecurringPickupBlock, isRecurringPickupSlotBlocked } = require("../src/lib/pickupRecurringBlocks");
const { makeDenverDateTime } = require("../src/lib/time/denverLocalDateTime");

let created, writes, notifications, existing;
const NativeDate = Date;
class TestDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : ["2026-11-06T15:00:00Z"])); }
}
const line = { id: "test-line", inventoryId: "TEST", openQty: 1, orderQty: 1, allocatedQty: 1, isAllocated: true, amount: 100, taxRate: 0 };
const payment = { terms: "NET 30", orderTotal: 100, unpaidBalance: 0, otherFees: 0 };
function reset() {
  created = []; writes = 0; notifications = 0;
  existing = { id: "existing", locationId: "slc-hq", status: "Scheduled",
    startAt: makeDenverDateTime("2026-11-10", "09:00"), endAt: makeDenverDateTime("2026-11-10", "09:15"),
    orders: [{ orderNbr: "TEST100" }], lines: [], customerFirstName: "Test", customerEmail: "test@example.invalid" };
}
const db = {
  pickupAppointment: {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => structuredClone(existing),
    create: async ({ data }) => { writes++; const row = { id: `created-${created.length}`, ...data }; created.push(row); return row; },
    update: async ({ data }) => { writes++; Object.assign(existing, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); return structuredClone(existing); },
  },
  pickupAppointmentOrder: { findMany: async () => [], createMany: async () => { writes++; }, deleteMany: async () => { writes++; } },
  pickupAppointmentLine: { createMany: async () => { writes++; }, deleteMany: async () => { writes++; } },
  pickupManualBlock: { findMany: async () => [], findFirst: async () => null,
    deleteMany: async () => { writes++; }, createMany: async () => { writes++; } },
  users: { findUnique: async () => null },
  erpOrderLine: { findMany: async () => [line] },
  erpOrderSummary: { findFirst: async ({ where }) => ({ orderNbr: where.orderNbr, baid: "TEST", status: "Open", ErpOrderPayment: payment, ErpOrderLine: [line] }) },
  erpOrderPayment: { findFirst: async () => payment },
  appointmentAccessToken: { findFirst: async () => ({ token: "offline-test" }) },
  orderReadyAccessToken: { findFirst: async () => ({ orderReady: { id: "notice", orderNbr: "TEST100" } }) },
  orderReadyNotice: { update: async () => { writes++; } },
  $transaction: async fn => fn({ ...db, $executeRaw: async () => 0 }),
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename.startsWith(root) && request.startsWith(".")) {
    const target = path.resolve(path.dirname(parent.filename), request);
    if (target === path.join(root, "src/lib/prisma")) return { prisma: db };
    if (target === path.join(root, "src/notifications")) return new Proxy({}, { get: () => async () => { notifications++; } });
    if (target.endsWith(path.join("notifications", "links", "tokens"))) return { getActiveToken: async () => ({ token: "offline-test" }), createAppointmentToken: async () => ({ token: "offline-test" }) };
    if (target.endsWith(path.join("middleware", "auth"))) return { requireAuth() {}, blockIfMustChangePassword() {}, blockIfMustCompleteProfile() {} };
    if (target.endsWith("refreshPrepayPayments")) return { refreshPrepayPaymentsIfNeeded: async () => {} };
    if (target.endsWith("ingestOrderReadyDetails")) return { refreshOrderReadyDetails() { throw Error("ERP calls are forbidden in this test"); } };
    if (target.endsWith("createAcumaticaService")) return { createAcumaticaService() { throw Error("ERP calls are forbidden in this test"); } };
    if (target.endsWith(path.join("queue", "erpClient"))) return { shouldUseQueueErp: () => false, queueErpJobRequest() { throw Error("Queue calls are forbidden in this test"); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
function loadRoute(relative, exportName) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  new Function("require", "exports", "module", "__filename", "__dirname", "Date", js)(
    mod.require.bind(mod), mod.exports, mod, filename, path.dirname(filename), TestDate
  );
  return mod.exports[exportName];
}
let staff, customer, publicAppointments;
try {
  staff = loadRoute("src/routes/pickups.ts", "pickupsRouter");
  customer = loadRoute("src/routes/customerPickups.ts", "customerPickupsRouter");
  publicAppointments = loadRoute("src/routes/publicAppointments.ts", "publicAppointmentsRouter");
} finally { Module._load = originalLoad; }
global.fetch = async () => { throw Error("Network calls are forbidden in this test"); };
process.env.FRONTEND_URL = "https://example.invalid/willcall";
async function call(router, method, routePath, body = {}, query = {}) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath}`);
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack[0].handle({ body, query, params: { id: "existing" },
    auth: { id: "admin-test", role: "ADMIN", locationAccess: ["slc-hq", "slc-outlet", "boise-willcall", "jackson-willcall", "provo-willcall"] } }, res);
  return res;
}
function staffBody(start = "10:00", end = "10:15", locationId = "slc-hq") {
  return { locationId, customerEmail: "test@example.invalid", customerFirstName: "Test",
    appointmentDate: "2026-11-09", appointmentStartTime: start, appointmentEndTime: end,
    orderNbrs: ["TEST100"], selectedItems: [{ orderNbr: "TEST100", items: [{ lineId: line.id, inventoryId: line.inventoryId, qty: 1 }] }] };
}
function customerBody(start = "10:00", end = "10:15", locationId = "slc-hq") {
  return { orderReadyToken: "offline-test", email: "test@example.invalid", firstName: "Test",
    groups: [{ locationId, orderNbrs: ["TEST100"], selectedDate: "2026-11-09", selectedSlots: [{ startTime: start, endTime: end }] }],
    selectedItems: staffBody().selectedItems };
}
function overlap(date, start, end, locationId = "slc-hq") {
  return findRecurringPickupBlock(locationId, makeDenverDateTime(date, start), makeDenverDateTime(date, end));
}
const tests = [
  ["only HQ Mondays on/after November 9 are blocked", async () => {
    assert.equal(getRecurringPickupBlock("slc-hq", "2026-11-02"), null);
    assert.ok(getRecurringPickupBlock("slc-hq", "2026-11-09"));
    assert.equal(getRecurringPickupBlock("slc-hq", "2026-11-10"), null);
    for (const location of ["slc-outlet", "boise-willcall", "jackson-willcall", "provo-willcall"]) assert.equal(getRecurringPickupBlock(location, "2026-11-09"), null);
    assert.ok(getRecurringPickupBlock("slc", "2026-11-09"));
  }],
  ["exact boundaries allow 9:45 and 10:45; all three meeting slots are blocked", async () => {
    assert.equal(overlap("2026-11-09", "09:45", "10:00"), null);
    assert.equal(overlap("2026-11-09", "10:45", "11:00"), null);
    for (const [start, end] of [["10:00", "10:15"], ["10:15", "10:30"], ["10:30", "10:45"], ["09:45", "10:15"], ["10:30", "11:00"]]) assert.ok(overlap("2026-11-09", start, end));
  }],
  ["Denver winter/summer offsets keep the meeting at the same local time", async () => {
    for (const [date, hour] of [["2026-11-09", 17], ["2027-03-08", 17], ["2027-03-15", 16], ["2027-11-08", 17]]) {
      assert.equal(makeDenverDateTime(date, "10:00").getUTCHours(), hour);
      assert.ok(overlap(date, "10:00", "10:15"));
      assert.equal(overlap(date, "10:45", "11:00"), null);
    }
  }],
  ["the rule continues indefinitely across calendar years", async () => {
    for (let i = 0; i < 520; i++) {
      const date = new NativeDate("2026-11-09T00:00:00Z"); date.setUTCDate(date.getUTCDate() + i * 7);
      assert.ok(getRecurringPickupBlock("slc-hq", date.toISOString().slice(0, 10)));
    }
  }],
  ["cross-day and multi-week appointment intervals cannot bypass the rule", async () => {
    assert.ok(findRecurringPickupBlock("slc-hq", makeDenverDateTime("2026-11-08", "23:45"), makeDenverDateTime("2026-11-09", "10:15")));
    assert.equal(findRecurringPickupBlock("slc-hq", makeDenverDateTime("2026-11-09", "10:45"), makeDenverDateTime("2026-11-16", "10:00")), null);
    assert.ok(findRecurringPickupBlock("slc-hq", makeDenverDateTime("2026-11-09", "10:45"), makeDenverDateTime("2026-11-16", "10:15")));
    assert.ok(findRecurringPickupBlock("slc-hq", makeDenverDateTime("2026-10-01", "09:00"), makeDenverDateTime("2026-11-09", "10:15")));
  }],
  ["staff and customer availability both block precisely the meeting slots", async () => {
    for (const router of [staff, customer]) {
      const result = await call(router, "get", "/availability", {}, { locationId: "slc-hq", from: "2026-11-09", to: "2026-11-09" });
      assert.equal(result.statusCode, 200);
      const slots = result.body.availability[0].slots;
      for (const start of ["10:00", "10:15", "10:30"]) assert.equal(slots.find(s => s.startTime === start).available, false);
      for (const start of ["09:45", "10:45"]) assert.equal(slots.find(s => s.startTime === start).available, true);
    }
  }],
  ["other stores retain available Monday meeting-hour slots", async () => {
    for (const locationId of ["slc-outlet", "boise-willcall", "jackson-willcall", "provo-willcall"]) {
      const res = await call(staff, "get", "/availability", {}, { locationId, from: "2026-11-09", to: "2026-11-09" });
      assert.equal(res.body.availability[0].slots.find(s => s.startTime === "10:00").available, true);
    }
  }],
  ["staff create rejects meeting slots even with a prepay override", async () => {
    const res = await call(staff, "post", "/", { ...staffBody(), prepayOverride: true });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, "SLOT_RECURRING_BLOCKED");
    assert.equal(writes, 0); assert.equal(notifications, 0);
  }],
  ["staff create also rejects appointments straddling the meeting start", async () => {
    assert.equal((await call(staff, "post", "/", staffBody("09:45", "10:15"))).statusCode, 409);
    assert.equal(writes, 0);
  }],
  ["staff can create at 10:45 and at other stores", async () => {
    assert.equal((await call(staff, "post", "/", staffBody("10:45", "11:00"))).statusCode, 201);
    reset(); assert.equal((await call(staff, "post", "/", staffBody("10:00", "10:15", "slc-outlet"))).statusCode, 201);
  }],
  ["staff cannot move an appointment into the meeting", async () => {
    const res = await call(staff, "patch", "/:id", { appointmentDate: "2026-11-09", appointmentStartTime: "10:15", appointmentEndTime: "10:30" });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, "SLOT_RECURRING_BLOCKED");
    assert.equal(writes, 0); assert.equal(notifications, 0);
  }],
  ["staff cannot reactivate a completed appointment into a meeting slot", async () => {
    existing.startAt = makeDenverDateTime("2026-11-09", "10:00"); existing.endAt = makeDenverDateTime("2026-11-09", "10:15"); existing.status = "Completed";
    const res = await call(staff, "patch", "/:id", { status: "Scheduled" });
    assert.equal(res.statusCode, 409); assert.equal(writes, 0);
  }],
  ["contact corrections on an existing overlapping appointment remain silent and allowed", async () => {
    existing.startAt = makeDenverDateTime("2026-11-09", "10:00"); existing.endAt = makeDenverDateTime("2026-11-09", "10:15");
    const res = await call(staff, "patch", "/:id", { customerPhone: "8015550100", notifyCustomer: false });
    assert.equal(res.statusCode, 200); assert.equal(notifications, 0);
  }],
  ["calendar make-available cannot remove the recurring rule", async () => {
    const res = await call(staff, "patch", "/availability", { locationId: "slc-hq", changes: [{ date: "2026-11-09", startTime: "10:15", available: true }] });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, "SLOT_RECURRING_BLOCKED");
    assert.equal(writes, 0);
    assert.ok(isRecurringPickupSlotBlocked("slc-hq", "2026-11-09", "10:15", "10:30"));
  }],
  ["manual availability editing outside the meeting still works", async () => {
    const res = await call(staff, "patch", "/availability", { locationId: "slc-hq", changes: [{ date: "2026-11-09", startTime: "10:45", available: true }] });
    assert.equal(res.statusCode, 200);
  }],
  ["order-ready customer booking rejects the meeting without writes or notifications", async () => {
    const res = await call(customer, "post", "/", customerBody());
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, "SLOT_RECURRING_BLOCKED");
    assert.equal(writes, 0); assert.equal(notifications, 0);
  }],
  ["order-ready customer booking at 10:45 still succeeds", async () => {
    assert.equal((await call(customer, "post", "/", customerBody("10:45", "11:00"))).statusCode, 201);
  }],
  ["public token rescheduling rejects the meeting without notifications", async () => {
    const res = await call(publicAppointments, "patch", "/:id", { action: "reschedule", selectedDate: "2026-11-09", selectedSlots: [{ startTime: "10:30", endTime: "10:45" }] }, { token: "offline-test" });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, "SLOT_RECURRING_BLOCKED");
    assert.equal(writes, 0); assert.equal(notifications, 0);
  }],
  ["public rescheduling can still use 10:45", async () => {
    const res = await call(publicAppointments, "patch", "/:id", { action: "reschedule", selectedDate: "2026-11-09", selectedSlots: [{ startTime: "10:45", endTime: "11:00" }] }, { token: "offline-test" });
    assert.equal(res.statusCode, 200);
  }],
];
(async () => {
  const previous = { info: console.info, log: console.log, warn: console.warn, error: console.error };
  const results = []; let failed = 0;
  console.info = console.log = console.warn = console.error = () => {};
  try {
    for (const [name, test] of tests) {
      reset();
      try { await test(); results.push(`PASS ${name}`); }
      catch (error) { failed++; results.push(`FAIL ${name}: ${error.message}`); }
    }
  } finally { Object.assign(console, previous); }
  for (const result of results) console.log(result);
  console.log(`${tests.length - failed}/${tests.length} passed; database and notifications mocked; no network access`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
