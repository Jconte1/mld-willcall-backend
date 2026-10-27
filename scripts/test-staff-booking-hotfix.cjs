// Offline route regression tests. All database, ERP and notification calls are mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { execFileSync } = require("node:child_process");
require("ts-node").register({ transpileOnly: true });

const routeFile = path.resolve(__dirname, "../src/routes/pickups.ts");
const baseline = process.argv.includes("--baseline");
const active = ["Scheduled", "Confirmed", "InProgress", "Ready"];
let rows, notifications, relationWrites, lockTail, payment, manualBlock;
const line = { id: "line-test", inventoryId: "TEST", orderNbr: "TEST100", openQty: 1, orderQty: 1, allocatedQty: 1, isAllocated: true, amount: 100, taxRate: 0 };
function reset() {
  rows = [];
  notifications = [];
  relationWrites = 0;
  lockTail = Promise.resolve();
  payment = { orderTotal: 100, unpaidBalance: 0, terms: "PP", otherFees: 0 };
  manualBlock = null;
}
function appointment(id, status = "Scheduled") {
  return { id, status, startAt: new Date("2099-10-27T15:45:00Z"), endAt: new Date("2099-10-27T16:00:00Z"), locationId: "slc-hq", customerEmail: "test@example.invalid", customerFirstName: "Test", customerPhone: "8015550100", orders: [{ orderNbr: "TEST100" }], lines: [] };
}
const db = {
  pickupAppointment: {
    findUnique: async ({ where }) => structuredClone(rows.find(r => r.id === where.id) ?? null),
    findFirst: async ({ where }) => rows.find(r => r.id !== where.id?.not && active.includes(r.status) && r.locationId === where.locationId && r.startAt < where.startAt.lt && r.endAt > where.endAt.gt) ?? null,
    create: async ({ data }) => {
      const row = { ...appointment(`test-${rows.length}`), ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)), orders: [], lines: [] };
      rows.push(row);
      return structuredClone(row);
    },
    update: async ({ where, data }) => {
      const row = rows.find(r => r.id === where.id);
      Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return structuredClone(row);
    },
  },
  pickupAppointmentOrder: {
    findMany: async ({ where }) => rows.filter(r => active.includes(r.status) && r.id !== where.appointment.id?.not).flatMap(r => r.orders.filter(o => where.orderNbr.in.includes(o.orderNbr)).map(o => ({ ...o, appointmentId: r.id, appointment: r }))),
    deleteMany: async ({ where }) => { relationWrites++; rows.find(r => r.id === where.appointmentId).orders = []; },
    createMany: async ({ data }) => { relationWrites++; for (const o of data) rows.find(r => r.id === o.appointmentId).orders.push(o); },
  },
  pickupAppointmentLine: { deleteMany: async () => {}, createMany: async () => {} },
  pickupManualBlock: { findFirst: async () => manualBlock },
  users: { findUnique: async () => null },
  erpOrderLine: { findMany: async () => [line] },
  erpOrderSummary: { findFirst: async ({ where }) => ({ orderNbr: where.orderNbr, baid: "TEST", status: "Open", ErpOrderLine: [line], ErpOrderPayment: [] }) },
  erpOrderPayment: { findFirst: async () => payment },
  $transaction: async (fn) => {
    let unlock;
    const tx = { ...db, $executeRaw: async () => {
      const previous = lockTail;
      lockTail = new Promise(resolve => { unlock = resolve; });
      await previous;
      return [];
    } };
    try { return await fn(tx); } finally { unlock?.(); }
  },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === routeFile) {
    if (request === "../lib/prisma") return { prisma: db };
    if (request === "../notifications") return new Proxy({}, { get: (_, key) => async (...args) => { notifications.push({ key, args }); } });
    if (request === "../middleware/auth") return { requireAuth() {}, blockIfMustChangePassword() {}, blockIfMustCompleteProfile() {} };
    if (request === "../lib/acumatica/sync/refreshPrepayPayments") return { refreshPrepayPaymentsIfNeeded: async () => {} };
    if (request === "../lib/acumatica/ingest/ingestOrderReadyDetails") return { refreshOrderReadyDetails: async () => { throw Error("Unexpected ERP call"); } };
    if (request === "../lib/acumatica/createAcumaticaService") return { createAcumaticaService() { throw Error("Unexpected ERP call"); } };
    if (request === "../lib/queue/erpClient") return { shouldUseQueueErp: () => false, queueErpJobRequest() { throw Error("Unexpected queue call"); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const source = baseline ? execFileSync("git", ["show", "1281c68:src/routes/pickups.ts"], { cwd: path.dirname(routeFile), encoding: "utf8" }) : fs.readFileSync(routeFile, "utf8");
const mod = new Module(routeFile, module);
mod.filename = routeFile;
mod.paths = Module._nodeModulePaths(path.dirname(routeFile));
mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, routeFile);
Module._load = originalLoad;
const router = mod.exports.pickupsRouter;
async function call(method, routePath, body, id) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack[0].handle({ body, params: { id }, auth: { id: "admin-test", role: "ADMIN", locationAccess: ["slc-hq"] } }, res);
  return res;
}
const createBody = { locationId: "slc-hq", customerEmail: "test@example.invalid", customerFirstName: "Test", startAt: "2099-10-27T15:45:00Z", endAt: "2099-10-27T16:00:00Z", orderNbrs: ["TEST100"], selectedItems: [{ orderNbr: "TEST100", items: [{ lineId: line.id, inventoryId: "TEST", qty: 1 }] }] };
const tests = [
  ["simultaneous staff submissions create exactly one appointment and confirmation", async () => {
    const result = await Promise.all([call("post", "/", createBody), call("post", "/", createBody)]);
    assert.deepEqual(result.map(r => r.statusCode).sort(), [201, 409]);
    assert.equal(rows.length, 1);
    assert.equal(notifications.filter(n => n.key === "notifyStaffScheduled").length, 1);
  }],
  ["cancelled duplicate permits silent contact edit without rewriting orders", async () => {
    rows.push(appointment("cancelled", "Cancelled"), appointment("scheduled"));
    const res = await call("patch", "/:id", { orderNbrs: ["TEST100"], status: "Cancelled", customerPhone: "8015550101", notifyCustomer: false }, "cancelled");
    assert.equal(res.statusCode, 200);
    assert.equal(rows[0].customerPhone, "8015550101");
    assert.equal(rows[1].customerPhone, "8015550100");
    assert.equal(relationWrites, 0);
    assert.equal(notifications.length, 0);
  }],
  ["scheduled duplicate permits silent contact edit without rewriting orders", async () => {
    rows.push(appointment("one"), appointment("two"));
    const res = await call("patch", "/:id", { orderNbrs: ["TEST100"], customerPhone: "8015550102", notifyCustomer: false }, "one");
    assert.equal(res.statusCode, 200);
    assert.equal(relationWrites, 0);
    assert.equal(notifications.length, 0);
  }],
  ["active appointment remains editable with an already cancelled sibling", async () => {
    rows.push(appointment("cancelled", "Cancelled"), appointment("scheduled"));
    const res = await call("patch", "/:id", { orderNbrs: ["TEST100"], customerPhone: "8015550103", notifyCustomer: false }, "scheduled");
    assert.equal(res.statusCode, 200);
    assert.equal(rows[1].customerPhone, "8015550103");
    assert.equal(notifications.length, 0);
  }],
  ["reactivating cancelled appointment still rejects an existing order reservation", async () => {
    rows.push(appointment("cancelled", "Cancelled"), { ...appointment("scheduled"), startAt: new Date("2099-10-27T17:00:00Z"), endAt: new Date("2099-10-27T17:15:00Z") });
    const res = await call("patch", "/:id", { status: "Scheduled" }, "cancelled");
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "ORDER_ALREADY_SCHEDULED");
    assert.equal(rows[0].status, "Cancelled");
    assert.equal(notifications.length, 0);
  }],
  ["adding a genuinely conflicting order is still rejected", async () => {
    rows.push({ ...appointment("one"), orders: [{ orderNbr: "OTHER" }] }, appointment("two"));
    assert.equal((await call("patch", "/:id", { orderNbrs: ["OTHER", "TEST100"] }, "one")).statusCode, 409);
  }],
  ["different orders cannot simultaneously occupy the same slot", async () => {
    const second = { ...createBody, orderNbrs: ["TEST200"], selectedItems: [{ ...createBody.selectedItems[0], orderNbr: "TEST200" }] };
    const result = await Promise.all([call("post", "/", createBody), call("post", "/", second)]);
    assert.deepEqual(result.map(r => r.statusCode).sort(), [201, 409]);
    assert.equal(rows.length, 1);
  }],
  ["prepay balance still blocks creation", async () => {
    payment.unpaidBalance = 100;
    const res = await call("post", "/", createBody);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "PREPAY_BLOCKED");
    assert.equal(rows.length, 0);
    assert.equal(notifications.length, 0);
  }],
  ["manual block still prevents creation", async () => {
    manualBlock = { date: new Date("2099-10-27"), startTime: "09:45" };
    const res = await call("post", "/", createBody);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "SLOT_MANUALLY_BLOCKED");
    assert.equal(rows.length, 0);
  }],
];
(async () => {
  let failed = 0;
  const log = console.log;
  console.info = console.warn = () => {};
  for (const [name, run] of tests) {
    reset();
    try { await run(); log(`PASS ${name}`); }
    catch (e) { failed++; log(`FAIL ${name}: ${e.message}`); }
  }
  log(`${tests.length - failed}/${tests.length} passed${baseline ? " (unmodified production baseline)" : ""}`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
