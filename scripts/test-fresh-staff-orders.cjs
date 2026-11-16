// Actual routes, ERP readers, snapshot verifier and inventory writer; all external I/O is intercepted.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
require("ts-node").register({ transpileOnly: true });
const root = path.resolve(__dirname, "..");
global.fetch = async () => { throw new Error("External network access is forbidden"); };
let erp, state, calls, sends, mutations, failInsert, lockTail, validToken;
const clone = value => structuredClone(value);
const value = v => ({ value: v });
function erpLine(id = "erp-line-a", sku = "TEST", qty = 7) {
  return { id, InventoryID: value(sku), LineType: value("Goods for Inventory"), LineDescription: value("Test item"),
    WarehouseID: value("SALT LAKE HARDWARE"), OpenQty: value(qty), OrderQty: value(7), Amount: value(70),
    TaxZone: value("SALT LAKE"), Allocations: [{ Allocated: value(true), Qty: value(qty) }] };
}
function reset() {
  erp = { header: { OrderNbr: value("HW06666"), CustomerID: value("BA0021191"), Status: value("Open"), LocationID: value("MAIN") },
    payment: { OrderNbr: value("HW06666"), Status: value("Open"), Terms: value("PP"), OrderTotal: value(75.355), UnpaidBalance: value(0) },
    inventory: [{ OrderNbr: value("HW06666"), Details: [erpLine()] }], failure: null, missing: false };
  state = { summary: { id: "summary", orderNbr: "HW06666", baid: "BA0021191", status: "Open", shipVia: null,
    updatedAt: new Date("2026-10-09"), lastSeenAt: new Date("2026-10-09"), lastAcumaticaPullAt: new Date("2026-10-09") },
    payment: { orderTotal: 75.355, unpaidBalance: 0, terms: "PP", status: "Open", updatedAt: new Date("2026-10-09") },
    lines: [{ id: "stale-a", orderNbr: "HW06666", inventoryId: "TEST", openQty: 7, orderQty: 7,
      isAllocated: true, allocatedQty: 7, amount: 70, taxRate: 7.65, updatedAt: new Date("2026-10-09") }], appointments: [] };
  calls = []; sends = []; mutations = 0; failInsert = false; lockTail = Promise.resolve(); validToken = true;
}
const summary = () => ({ ...clone(state.summary), ErpOrderPayment: clone(state.payment), ErpOrderLine: clone(state.lines) });
const active = ["Scheduled", "Confirmed", "InProgress", "Ready"];
const db = {
  erpOrderSummary: {
    findFirst: async () => summary(), findUniqueOrThrow: async () => summary(),
    findMany: async () => [{ id: state.summary.id, orderNbr: state.summary.orderNbr }],
    upsert: async ({ update }) => { Object.assign(state.summary, update); return clone(state.summary); },
    update: async ({ data }) => { Object.assign(state.summary, data); return clone(state.summary); },
  },
  erpOrderPayment: {
    findFirst: async () => clone(state.payment),
    upsert: async ({ update }) => { Object.assign(state.payment, update); return clone(state.payment); },
  },
  erpOrderLine: {
    findMany: async () => clone(state.lines),
    deleteMany: async () => { const count = state.lines.length; state.lines = []; return { count }; },
    createMany: async ({ data }) => {
      if (failInsert) throw Error("Simulated insert failure");
      state.lines.push(...clone(data)); return { count: data.length };
    },
  },
  staffUser: { findFirst: async () => null }, users: { findUnique: async () => null },
  erpOrderAddress: { upsert: async () => ({}) }, erpOrderContact: { upsert: async () => ({}) },
  pickupManualBlock: { findFirst: async () => null },
  orderReadyAccessToken: { findFirst: async () => validToken ? { orderReady: { id: "notice-test", orderNbr: "HW06666" } } : null },
  orderReadyNotice: { update: async () => ({}) },
  pickupAppointmentOrder: {
    findMany: async () => [], deleteMany: async ({ where }) => { mutations++; state.appointments.find(a => a.id === where.appointmentId).orders = []; },
    createMany: async ({ data }) => { mutations++; for (const row of data) state.appointments.find(a => a.id === row.appointmentId).orders.push(row); },
  },
  pickupAppointmentLine: {
    deleteMany: async () => { mutations++; },
    createMany: async ({ data }) => { mutations++; for (const row of data) state.appointments.find(a => a.id === row.appointmentId).lines.push(row); },
  },
  pickupAppointment: {
    findFirst: async () => null,
    findUnique: async ({ where }) => clone(state.appointments.find(a => a.id === where.id) ?? null),
    create: async ({ data }) => { mutations++; const row = { id: "new-appointment", orders: [], lines: [], ...data }; state.appointments.push(row); return clone(row); },
    update: async ({ where, data }) => { mutations++; const row = state.appointments.find(a => a.id === where.id);
      Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); return clone(row); },
  },
  $transaction: async fn => {
    const previous = lockTail; let release; lockTail = new Promise(resolve => { release = resolve; });
    await previous;
    const before = clone(state);
    try { return await fn({ ...db, $executeRaw: async () => 1 }); }
    catch (error) { state = before; throw error; }
    finally { release(); }
  },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const target = request.startsWith(".") && parent ? path.resolve(path.dirname(parent.filename), request) : "";
  if (target === path.join(root, "src/lib/prisma")) return { prisma: db };
  if (target === path.join(root, "src/middleware/auth")) return { requireAuth() {}, blockIfMustChangePassword() {}, blockIfMustCompleteProfile() {} };
  if (target === path.join(root, "src/notifications")) return new Proxy({}, { get: (_, key) => async () => sends.push(key) });
  if (target.endsWith("createAcumaticaService")) return { createAcumaticaService: () => ({ baseUrl: "https://erp.invalid", getToken: async () => "offline" }) };
  if (target.endsWith("refreshPrepayPayments")) return { refreshPrepayPaymentsIfNeeded: async () => {} };
  if (target === path.join(root, "src/lib/queue/erpClient")) return {
    shouldUseQueueErp: () => true,
    queueErpJobRequest: async (url, payload) => {
      calls.push({ url, payload });
      if (erp.failure) throw Error(erp.failure);
      if (url.endsWith("/header")) return erp.missing ? { found: false } : { found: true, row: clone(erp.header) };
      if (url.endsWith("/payment-info")) return { rows: erp.payment ? [clone(erp.payment)] : [] };
      if (url.endsWith("/inventory-details")) return erp.badEnvelope ? {} : { rows: clone(erp.inventory) };
      if (url.endsWith("/address-contact")) return { rows: [] };
      throw Error("Unexpected queue operation: " + url);
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const router = require("../src/routes/pickups").pickupsRouter;
const customerRouter = require("../src/routes/customerPickups").customerPickupsRouter;
const { refreshVerifiedPickupOrder } = require("../src/lib/acumatica/ingest/refreshVerifiedPickupOrder");
const { refreshOrderReadyDetails } = require("../src/lib/acumatica/ingest/ingestOrderReadyDetails");
const { default: writeInventoryDetails, prepareInventoryDetails } = require("../src/lib/acumatica/write/writeInventoryDetails");
const interceptedLoad = Module._load;
Module._load = originalLoad;
function loadProductionBaseline() {
  const cache = new Map();
  function compile(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(root, relative);
    const source = execFileSync("git", ["show", `dfb28f6:${relative}`], { cwd: root, encoding: "utf8" });
    const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(relative, mod);
    mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
    return mod.exports;
  }
  Module._load = function(request, parent, isMain) {
    const target = request.startsWith(".") && parent ? path.resolve(path.dirname(parent.filename), request) : "";
    for (const relative of ["src/lib/acumatica/ingest/ingestOrderReadyDetails.ts", "src/lib/acumatica/write/writeInventoryDetails.ts"]) {
      if (target === path.join(root, relative.slice(0, -3))) return compile(relative);
    }
    return interceptedLoad.call(this, request, parent, isMain);
  };
  try { return compile("src/routes/pickups.ts").pickupsRouter; } finally { Module._load = originalLoad; }
}
async function call(method, route, body = {}, id = "existing", role = "ADMIN") {
  const layer = router.stack.find(l => l.route?.path === route && l.route.methods[method]);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await layer.route.stack[0].handle({ body, params: { id }, auth: { id: "staff-test", role, locationAccess: ["slc-hq"] } }, res);
  return res;
}
function booking(items = [{ lineId: "stale-a", inventoryId: "TEST", qty: 1 }]) {
  return { locationId: "slc-hq", customerEmail: "test@example.invalid", customerFirstName: "Test", startAt: "2099-10-27T15:45:00Z",
    endAt: "2099-10-27T16:00:00Z", orderNbrs: ["HW06666"], selectedItems: [{ orderNbr: "HW06666", items }] };
}
function existing() {
  state.appointments.push({ id: "existing", locationId: "slc-hq", status: "Scheduled", startAt: new Date("2099-10-27T15:45:00Z"),
    endAt: new Date("2099-10-27T16:00:00Z"), customerEmail: "test@example.invalid", customerFirstName: "Test",
    orders: [{ orderNbr: "HW06666" }], lines: [{ lineId: "stale-a", inventoryId: "TEST", orderNbr: "HW06666", qtySelected: 1 }] });
}
async function customerBooking(items = [{ lineId: "stale-a", inventoryId: "TEST", qty: 1 }]) {
  const body = { orderReadyToken: "offline-test", email: "test@example.invalid", firstName: "Test", phone: "8015550100",
    groups: [{ locationId: "slc-hq", orderNbrs: ["HW06666"], selectedDate: "2099-10-27", selectedSlots: [{ startTime: "09:45", endTime: "10:00" }] }],
    selectedItems: [{ orderNbr: "HW06666", items }] };
  const layer = customerRouter.stack.find(l => l.route?.path === "/" && l.route.methods.post);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await layer.route.stack[0].handle({ body, params: {} }, res); return res;
}
async function blockedCreate(expected, items, override = false) {
  const result = await call("post", "/", { ...booking(items), prepayOverride: override });
  assert.equal(result.body.code, expected, JSON.stringify(result.body));
  assert.equal(state.appointments.length, 0); assert.equal(mutations, 0); assert.equal(sends.length, 0);
  return result;
}
const tests = [
  ["production baseline reproduction: Completed ERP order still returns stale selectable items and allows booking", async () => {
    const baseline = loadProductionBaseline();
    erp.header.Status = value("Completed"); erp.payment.Status = value("Completed"); erp.inventory = [];
    const invoke = async (route, body) => {
      const layer = baseline.stack.find(l => l.route?.path === route && l.route.methods.post);
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await layer.route.stack[0].handle({ body, params: {}, auth: { id: "staff-test", role: "ADMIN", locationAccess: ["slc-hq"] } }, res);
      return res;
    };
    const lookup = await invoke("/orders/lookup", { orderNbr: "HW06666" });
    assert.equal(lookup.statusCode, 200); assert.equal(lookup.body.order.status, "Open");
    assert.equal(lookup.body.order.payment.status, "Completed"); assert.equal(lookup.body.order.lines[0].openQty, 7);
    assert.equal((await invoke("/", booking())).statusCode, 201); assert.equal(state.appointments.length, 1);
  }],
  ["HW06666 replay: fresh Completed status blocks lookup despite old Open summary and positive quantities", async () => {
    erp.header.Status = value("Completed"); erp.payment.Status = value("Completed"); erp.inventory = [];
    const result = await call("post", "/orders/lookup", { orderNbr: "HW06666" });
    assert.equal(result.statusCode, 409); assert.equal(result.body.code, "ORDER_NOT_ELIGIBLE");
    assert.match(result.body.message, /Completed/); assert.equal(mutations, 0); assert.equal(sends.length, 0);
  }],
  ["completed orders cannot be booked even with admin payment override", async () => {
    erp.header.Status = value("Completed"); await blockedCreate("ORDER_NOT_ELIGIBLE", undefined, true);
  }],
  ["fresh payment status catches completion after the header was read", async () => {
    erp.payment.Status = value("Completed"); erp.inventory = []; await blockedCreate("ORDER_NOT_ELIGIBLE");
  }],
  ["empty inventory response cannot authorize old cached items or advance freshness", async () => {
    const before = clone(state); erp.inventory = []; await blockedCreate("ERP_VERIFICATION_FAILED"); assert.deepEqual(state, before);
  }],
  ["malformed queue inventory envelope fails closed", async () => { erp.badEnvelope = true; await blockedCreate("ERP_VERIFICATION_FAILED"); }],
  ["missing payment data cannot be interpreted as paid", async () => { erp.payment = null; await blockedCreate("ERP_VERIFICATION_FAILED"); }],
  ["missing terms fails verification", async () => { delete erp.payment.Terms; await blockedCreate("ERP_VERIFICATION_FAILED"); }],
  ["missing payment status is a verification failure rather than a cached-order success", async () => {
    delete erp.payment.Status; await blockedCreate("ERP_VERIFICATION_FAILED");
  }],
  ["blank payment balance cannot be interpreted as zero owed", async () => {
    erp.payment.UnpaidBalance = value("   "); await blockedCreate("ERP_VERIFICATION_FAILED");
  }],
  ["ERP timeout returns retryable 503 instead of cached success or false not-found", async () => {
    erp.failure = "Queue ERP job timeout"; assert.equal((await blockedCreate("ERP_VERIFICATION_FAILED")).statusCode, 503);
  }],
  ["genuine ERP not-found is distinct from a timeout", async () => {
    erp.missing = true; const result = await call("post", "/orders/lookup", { orderNbr: "HW06666" }); assert.equal(result.statusCode, 404);
  }],
  ["zero-open-quantity ERP items cannot be selected or booked", async () => {
    erp.inventory[0].Details[0].OpenQty = value(0); await blockedCreate("NO_PICKUP_ITEMS");
  }],
  ["unallocated ERP items cannot be booked", async () => {
    erp.inventory[0].Details[0].Allocations = []; await blockedCreate("NO_PICKUP_ITEMS");
  }],
  ["missing open quantity cannot become a permissive default", async () => {
    delete erp.inventory[0].Details[0].OpenQty; await blockedCreate("ERP_VERIFICATION_FAILED");
  }],
  ["missing stable ERP identity fails verification", async () => {
    delete erp.inventory[0].Details[0].id; await blockedCreate("ERP_VERIFICATION_FAILED");
  }],
  ["unexpected order in inventory response fails before persistence", async () => {
    erp.inventory[0].OrderNbr = value("OTHER"); const before = clone(state); await blockedCreate("ERP_VERIFICATION_FAILED"); assert.deepEqual(state, before);
  }],
  ["paid open order lookup returns fresh quantities and stable IDs", async () => {
    const result = await call("post", "/orders/lookup", { orderNbr: "HW06666" }); assert.equal(result.statusCode, 200);
    assert.equal(result.body.order.lines.length, 1); assert.equal(result.body.order.lines[0].openQty, 7);
    assert.notEqual(result.body.order.lines[0].id, "stale-a");
    assert.ok(state.summary.lastAcumaticaPullAt > new Date("2026-10-09"));
  }],
  ["valid lookup followed by booking refetches ERP and creates exactly one appointment", async () => {
    const lookup = await call("post", "/orders/lookup", { orderNbr: "HW06666" });
    const line = lookup.body.order.lines[0]; const headers = calls.filter(c => c.url.endsWith("/header")).length;
    const result = await call("post", "/", booking([{ lineId: line.id, inventoryId: line.inventoryId, qty: 7 }]));
    assert.equal(result.statusCode, 201, JSON.stringify(result.body)); assert.equal(state.appointments.length, 1);
    assert.equal(calls.filter(c => c.url.endsWith("/header")).length, headers + 1);
    assert.equal(sends.filter(s => s === "notifyStaffScheduled").length, 1);
  }],
  ["completion between lookup and submit rejects booking", async () => {
    const lookup = await call("post", "/orders/lookup", { orderNbr: "HW06666" }); erp.header.Status = value("Completed");
    await blockedCreate("ORDER_NOT_ELIGIBLE", [{ lineId: lookup.body.order.lines[0].id, inventoryId: "TEST", qty: 1 }]);
  }],
  ["quantity decrease between lookup and submit uses the new quantity", async () => {
    const lookup = await call("post", "/orders/lookup", { orderNbr: "HW06666" }); erp.inventory[0].Details[0].OpenQty = value(2);
    await blockedCreate("ORDER_QUANTITY_CHANGED", [{ lineId: lookup.body.order.lines[0].id, inventoryId: "TEST", qty: 7 }]);
  }],
  ["selected quantity cannot exceed allocated quantity even when open quantity is larger", async () => {
    erp.inventory[0].Details[0].Allocations[0].Qty = value(2);
    const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    await blockedCreate("ORDER_QUANTITY_CHANGED", [{ lineId: id, inventoryId: "TEST", qty: 3 }]);
  }],
  ["fractional allocations are never rounded up into an extra available unit", async () => {
    erp.inventory[0].Details[0].Allocations[0].Qty = value(1.6);
    const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    await blockedCreate("ORDER_QUANTITY_CHANGED", [{ lineId: id, inventoryId: "TEST", qty: 2 }]);
  }],
  ["legitimate separate ERP lines with the same model retain distinct stable identities", async () => {
    erp.inventory[0].Details.push(erpLine("erp-line-b"));
    const first = await call("post", "/orders/lookup", { orderNbr: "HW06666" });
    const second = await call("post", "/orders/lookup", { orderNbr: "HW06666" });
    assert.equal(first.body.order.lines.length, 2); assert.notEqual(first.body.order.lines[0].id, first.body.order.lines[1].id);
    assert.deepEqual(first.body.order.lines.map(l => l.id), second.body.order.lines.map(l => l.id));
    const result = await call("post", "/", booking(first.body.order.lines.map(l => ({ lineId: l.id, inventoryId: "TEST", qty: 7 }))));
    assert.equal(result.statusCode, 201);
  }],
  ["ambiguous model-only selection is rejected instead of picking an arbitrary ERP line", async () => {
    erp.inventory[0].Details.push(erpLine("erp-line-b")); await blockedCreate("ORDER_ITEMS_CHANGED", [{ inventoryId: "TEST", qty: 1 }]);
  }],
  ["an obsolete line ID cannot silently fall back to a model match", async () => { await blockedCreate("ORDER_ITEMS_CHANGED"); }],
  ["legacy random cache IDs migrate to the fresh ERP identity only for an unambiguous model", async () => {
    const result = await call("post", "/", booking([{ lineId: "1e8c09df-32ec-4b16-a083-e85f3503a58a", inventoryId: "TEST", qty: 1 }]));
    assert.equal(result.statusCode, 201); assert.match(state.appointments[0].lines[0].lineId, /^[0-9a-f]{64}$/);
  }],
  ["legacy cache IDs never choose arbitrarily between legitimate same-model ERP lines", async () => {
    erp.inventory[0].Details.push(erpLine("erp-line-b"));
    await blockedCreate("ORDER_ITEMS_CHANGED", [{ lineId: "1e8c09df-32ec-4b16-a083-e85f3503a58a", inventoryId: "TEST", qty: 1 }]);
  }],
  ["duplicate submitted lines are summed before quantity validation", async () => {
    const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    await blockedCreate("ORDER_QUANTITY_CHANGED", [{ lineId: id, inventoryId: "TEST", qty: 4 }, { lineId: id, inventoryId: "TEST", qty: 4 }]);
  }],
  ["a selected line ID must belong to the submitted model", async () => {
    const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    await blockedCreate("ORDER_ITEMS_CHANGED", [{ lineId: id, inventoryId: "OTHER_MODEL", qty: 1 }]);
  }],
  ["concurrent inventory refreshes replace rather than append duplicate models", async () => {
    await Promise.all(Array.from({ length: 10 }, () => writeInventoryDetails("BA0021191", erp.inventory)));
    assert.equal(state.lines.length, 1);
  }],
  ["repeated identical ERP line identities are not inserted twice", async () => {
    erp.inventory[0].Details.push(clone(erp.inventory[0].Details[0]));
    await writeInventoryDetails("BA0021191", erp.inventory); assert.equal(state.lines.length, 1);
  }],
  ["conflicting duplicate ERP identities fail before replacement", async () => {
    const copy = clone(erp.inventory[0].Details[0]); copy.OpenQty = value(2); erp.inventory[0].Details.push(copy);
    const before = clone(state); await assert.rejects(() => writeInventoryDetails("BA0021191", erp.inventory), /Conflicting ERP/); assert.deepEqual(state, before);
  }],
  ["failed line insertion rolls back deletion, status, payment and freshness", async () => {
    const before = clone(state); failInsert = true; await assert.rejects(() => refreshVerifiedPickupOrder("HW06666")); assert.deepEqual(state, before);
  }],
  ["explicit empty replacement clears only the requested order snapshot", async () => {
    await writeInventoryDetails("BA0021191", [], { expectedOrderNbrs: ["HW06666"] }); assert.equal(state.lines.length, 0);
  }],
  ["shared order-ready refresh uses fresh Completed status and clears stale lines", async () => {
    erp.payment.Status = value("Completed"); erp.inventory = [];
    await refreshOrderReadyDetails({ baid: "BA0021191", orderNbr: "HW06666", status: "Open" });
    assert.equal(state.summary.status, "Completed"); assert.equal(state.lines.length, 0);
  }],
  ["shared order-ready refresh does not mark an empty active-order response fresh", async () => {
    erp.inventory = []; const before = clone(state);
    await assert.rejects(() => refreshOrderReadyDetails({ baid: "BA0021191", orderNbr: "HW06666", status: "Open" })); assert.deepEqual(state, before);
  }],
  ["unpaid prepay still requires override; fresh eligible order allows admin override", async () => {
    erp.payment.UnpaidBalance = value(75.355); const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    const items = [{ lineId: id, inventoryId: "TEST", qty: 7 }]; await blockedCreate("PREPAY_BLOCKED", items);
    const result = await call("post", "/", { ...booking(items), prepayOverride: true }); assert.equal(result.statusCode, 201);
  }],
  ["contact-only corrections on completed ERP orders do not fetch ERP or send notices", async () => {
    existing(); erp.header.Status = value("Completed");
    const result = await call("patch", "/:id", { customerPhone: "8015550100", notifyCustomer: false });
    assert.equal(result.statusCode, 200); assert.equal(calls.length, 0); assert.equal(sends.length, 0);
  }],
  ["removing obsolete items remains possible without an ERP request", async () => {
    existing(); erp.failure = "ERP unavailable";
    const result = await call("patch", "/:id", { selectedItems: [], notifyCustomer: false });
    assert.equal(result.statusCode, 200); assert.equal(calls.length, 0);
  }],
  ["adding items to an existing appointment revalidates ERP and rejects completed orders", async () => {
    existing(); erp.header.Status = value("Completed");
    const result = await call("patch", "/:id", { selectedItems: [{ orderNbr: "HW06666", items: [{ lineId: "stale-a", inventoryId: "TEST", qty: 2 }] }] });
    assert.equal(result.body.code, "ORDER_NOT_ELIGIBLE"); assert.equal(mutations, 0); assert.equal(sends.length, 0);
  }],
  ["reactivating an appointment requires fresh eligible ERP data", async () => {
    existing(); state.appointments[0].status = "Cancelled"; erp.header.Status = value("Completed");
    const result = await call("patch", "/:id", { status: "Scheduled" }); assert.equal(result.body.code, "ORDER_NOT_ELIGIBLE"); assert.equal(mutations, 0);
  }],
  ["unknown and held ERP statuses cannot be scheduled", async () => {
    for (const status of ["Invoiced", "Canceled", "Credit Hold", "Pending Approval", "Unknown Future Status"]) {
      erp.header.Status = value(status); await blockedCreate("ORDER_NOT_ELIGIBLE");
    }
  }],
  ["order-ready customer booking rejects completed orders without appointment writes or notices", async () => {
    erp.header.Status = value("Completed"); const result = await customerBooking();
    assert.equal(result.body.code, "ORDER_NOT_ELIGIBLE"); assert.equal(mutations, 0); assert.equal(sends.length, 0);
  }],
  ["order-ready token validation still runs before any ERP request", async () => {
    validToken = false; assert.equal((await customerBooking()).statusCode, 403); assert.equal(calls.length, 0);
  }],
  ["order-ready customer booking fails closed on an empty ERP response", async () => {
    erp.inventory = []; const result = await customerBooking();
    assert.equal(result.body.code, "ERP_VERIFICATION_FAILED"); assert.equal(mutations, 0); assert.equal(sends.length, 0);
  }],
  ["order-ready customer booking rejects zero-open-quantity items", async () => {
    erp.inventory[0].Details[0].OpenQty = value(0); assert.equal((await customerBooking()).body.code, "NO_PICKUP_ITEMS"); assert.equal(mutations, 0);
  }],
  ["order-ready customer booking retains valid paid-order scheduling and customer confirmation", async () => {
    const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    const result = await customerBooking([{ lineId: id, inventoryId: "TEST", qty: 7 }]);
    assert.equal(result.statusCode, 201, JSON.stringify(result.body)); assert.equal(state.appointments.length, 1);
    assert.equal(sends.filter(s => s === "notifyCustomerScheduled").length, 1);
  }],
  ["order-ready customers with pre-deployment cache IDs can still book verified eligible items", async () => {
    const result = await customerBooking([{ lineId: "1e8c09df-32ec-4b16-a083-e85f3503a58a", inventoryId: "TEST", qty: 1 }]);
    assert.equal(result.statusCode, 201); assert.match(state.appointments[0].lines[0].lineId, /^[0-9a-f]{64}$/);
  }],
  ["order-ready customer booking preserves the prepay gate", async () => {
    erp.payment.UnpaidBalance = value(75.355); const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    assert.equal((await customerBooking([{ lineId: id, inventoryId: "TEST", qty: 7 }])).body.code, "PREPAY_BLOCKED"); assert.equal(mutations, 0);
  }],
  ["order-ready duplicate selected lines cannot exceed the fresh available quantity", async () => {
    const id = prepareInventoryDetails("BA0021191", erp.inventory, true).lines[0].id;
    assert.equal((await customerBooking([{ lineId: id, inventoryId: "TEST", qty: 4 }, { lineId: id, inventoryId: "TEST", qty: 4 }])).body.code, "ORDER_QUANTITY_CHANGED");
    assert.equal(mutations, 0);
  }],
  ["existing active appointment can still be moved after its shipment completes the ERP order", async () => {
    existing(); erp.header.Status = value("Completed");
    const result = await call("patch", "/:id", { startAt: "2099-10-27T17:00:00Z", endAt: "2099-10-27T17:15:00Z", notifyCustomer: false });
    assert.equal(result.statusCode, 200); assert.equal(calls.length, 0);
  }],
];
(async () => {
  const log = console.log; console.info = console.warn = console.log = () => {};
  let failed = 0;
  for (const [name, run] of tests) {
    reset(); try { await run(); log("PASS " + name); } catch (error) { failed++; log("FAIL " + name + ": " + error.stack); }
  }
  log(JSON.stringify({ passed: tests.length - failed, total: tests.length, externalNetworkRequests: 0, productionWrites: 0,
    acumaticaWrites: 0, realNotifications: 0, database: "transactional in-memory test double" }));
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
