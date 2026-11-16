// Destructive test fixtures are permitted ONLY in this dedicated localhost test database.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { execFileSync } = require("node:child_process");
require("ts-node").register({ transpileOnly: true });
const { PrismaClient } = require("@prisma/client");
const url = "postgresql://willcall_hotfix@127.0.0.1:55434/fresh_orders_hotfix_test?connection_limit=12";
const parsed = new URL(url);
assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.port, "55434"); assert.equal(parsed.pathname, "/fresh_orders_hotfix_test");
const db = new PrismaClient({ datasourceUrl: url });
global.fetch = async () => { throw Error("External network access is forbidden"); };
const root = path.resolve(__dirname, "..");
const value = value => ({ value });
const baid = "HOTFIX_TEST_BAID";
const orderNbr = `HOTFIX${Date.now()}`;
function line(id, qty = 7) {
  return { id, InventoryID: value("SAME_MODEL"), LineType: value("Goods for Inventory"), OpenQty: value(qty),
    OrderQty: value(7), Amount: value(70), Allocations: [{ Allocated: value(true), Qty: value(qty) }] };
}
let details = [{ OrderNbr: value(orderNbr), Details: [line("erp-a"), line("erp-b")] }];
const oldLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const target = request.startsWith(".") && parent ? path.resolve(path.dirname(parent.filename), request) : "";
  if (target === path.join(root, "src/lib/prisma")) return { prisma: db };
  if (target.endsWith("createAcumaticaService")) return { createAcumaticaService: () => ({ baseUrl: "https://erp.invalid", getToken: async () => "offline" }) };
  if (target.endsWith(path.join("queue", "erpClient"))) return { shouldUseQueueErp: () => true, queueErpJobRequest: async url => {
    if (url.endsWith("/header")) return { found: true, row: { OrderNbr: value(orderNbr), CustomerID: value(baid), Status: value("Open") } };
    if (url.endsWith("/payment-info")) return { rows: [{ OrderNbr: value(orderNbr), Status: value("Open"), Terms: value("PP"), OrderTotal: value(140), UnpaidBalance: value(0) }] };
    if (url.endsWith("/inventory-details")) return { rows: details };
    throw Error("Unexpected queue operation: " + url);
  } };
  return oldLoad.call(this, request, parent, isMain);
};
const { default: writeInventoryDetails } = require("../src/lib/acumatica/write/writeInventoryDetails");
const { refreshVerifiedPickupOrder } = require("../src/lib/acumatica/ingest/refreshVerifiedPickupOrder");
Module._load = oldLoad;
const log = console.log; console.info = console.warn = console.log = () => {};
let passed = 0;
async function test(name, fn) { await fn(); passed++; log("PASS " + name); }
async function snapshot() {
  return {
    summary: await db.erpOrderSummary.findUnique({ where: { baid_orderNbr: { baid, orderNbr } },
      select: { id: true, status: true, updatedAt: true, lastSeenAt: true, lastAcumaticaPullAt: true } }),
    payment: await db.erpOrderPayment.findMany({ where: { baid, orderNbr } }),
    lines: await db.erpOrderLine.findMany({ where: { baid, orderNbr }, orderBy: { id: "asc" } }),
  };
}
(async () => {
  try {
    await db.erpOrderSummary.create({ data: { baid, orderNbr, status: "Open", updatedAt: new Date("2026-10-09") }, select: { id: true } });
    await test("real PostgreSQL production-baseline reproduction: overlapping delete/insert refreshes create four rows for two ERP lines", async () => {
      let arrived = 0, release; const barrier = new Promise(resolve => { release = resolve; });
      const baselineDb = { erpOrderSummary: db.erpOrderSummary, erpOrderLine: {
        deleteMany: async args => { const result = await db.erpOrderLine.deleteMany(args); if (++arrived === 2) release(); await barrier; return result; },
        createMany: args => db.erpOrderLine.createMany(args),
      } };
      const filename = path.join(root, "src/lib/acumatica/write/writeInventoryDetails.ts");
      const source = execFileSync("git", ["show", "dfb28f6:src/lib/acumatica/write/writeInventoryDetails.ts"], { cwd: root, encoding: "utf8" });
      const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
      Module._load = function(request, parent, isMain) {
        if (parent?.filename === filename && request === "../../prisma") return { prisma: baselineDb };
        return oldLoad.call(this, request, parent, isMain);
      };
      try { mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename); }
      finally { Module._load = oldLoad; }
      await Promise.all([mod.exports.default(baid, details), mod.exports.default(baid, details)]);
      assert.equal((await snapshot()).lines.length, 4);
    });
    await test("real PostgreSQL: 10 concurrent replacements leave exactly two legitimate same-model ERP lines", async () => {
      await Promise.all(Array.from({ length: 10 }, () => writeInventoryDetails(baid, details)));
      const rows = (await snapshot()).lines; assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
    });
    await test("real PostgreSQL: fresh status, payment, lines and timestamp commit as one snapshot", async () => {
      const result = await refreshVerifiedPickupOrder(orderNbr); assert.equal(result.status, "Open");
      assert.equal(result.ErpOrderLine.length, 2); assert.equal(result.ErpOrderPayment.terms, "PP");
      assert.ok((await snapshot()).summary.lastAcumaticaPullAt > new Date("2026-10-09"));
    });
    await test("real PostgreSQL: failed insertion rolls back deleted lines, payment and freshness", async () => {
      const before = await snapshot();
      details = [{ OrderNbr: value(orderNbr), Details: [{ ...line("erp-invalid"), InventoryID: value("X".repeat(129)) }] }];
      await assert.rejects(() => refreshVerifiedPickupOrder(orderNbr), /Could not verify/);
      assert.deepEqual(await snapshot(), before);
    });
    await test("real PostgreSQL: concurrent readers see the previous committed snapshot while replacement is uncommitted", async () => {
      let release; const wait = new Promise(resolve => { release = resolve; });
      let deleted; const ready = new Promise(resolve => { deleted = resolve; });
      const replacement = db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory:${baid}:${orderNbr}`}))`;
        await tx.erpOrderLine.deleteMany({ where: { baid, orderNbr } }); deleted(); await wait;
        throw Error("Rollback test replacement");
      }, { timeout: 15000 });
      const caught = replacement.catch(error => error);
      await ready;
      try { assert.equal((await snapshot()).lines.length, 2); } finally { release(); }
      assert.match((await caught).message, /Rollback test/); assert.equal((await snapshot()).lines.length, 2);
    });
    await test("real PostgreSQL: explicit empty replacement clears only the specified order", async () => {
      await db.erpOrderSummary.create({ data: { baid, orderNbr: `${orderNbr}OTHER`, status: "Open", updatedAt: new Date() }, select: { id: true } });
      await writeInventoryDetails(baid, [{ OrderNbr: value(`${orderNbr}OTHER`), Details: [line("other-line")] }]);
      await writeInventoryDetails(baid, [], { expectedOrderNbrs: [orderNbr] });
      assert.equal((await snapshot()).lines.length, 0);
      assert.equal(await db.erpOrderLine.count({ where: { baid, orderNbr: `${orderNbr}OTHER` } }), 1);
    });
    log(JSON.stringify({ passed, total: 6, database: "real PostgreSQL 17, isolated localhost:55434", productionWrites: 0, acumaticaWrites: 0 }));
  } finally {
    await db.erpOrderSummary.deleteMany({ where: { baid, orderNbr: { in: [orderNbr, `${orderNbr}OTHER`] } } });
    await db.$disconnect();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
