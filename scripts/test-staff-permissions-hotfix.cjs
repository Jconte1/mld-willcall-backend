// Real HTTP routes and JWT verification, with an in-memory database and blocked notifications/ERP.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
require("ts-node").register({ transpileOnly: true });
const express = require("express");
const jwt = require("jsonwebtoken");
const root = path.resolve(__dirname, "..");
process.env.JWT_SECRET = "offline-staff-permission-regression-only";
process.env.FRONTEND_URL = "https://example.invalid/willcall";
let failDatabase = false, writes = 0, sends = 0;
const allStores = ["slc-hq", "slc-outlet", "boise-willcall", "jackson-willcall", "provo-willcall"];
const account = { id: "staff-test", email: "staff@example.invalid", name: "Staff Test", role: "ADMIN", locationAccess: ["boise-willcall"], isActive: true, mustChangePassword: false, salespersonNumber: "1234", salespersonName: "Staff Test" };
const rows = ["slc-hq", "boise-willcall", "jackson-willcall", "slc", "slc-outlet"].map((locationId, i) => ({ id: `apt-${i}`, locationId, status: "Scheduled", orders: [], shipments: [], lines: [], startAt: new Date("2099-10-27T15:45:00Z"), endAt: new Date("2099-10-27T16:00:00Z") }));
const db = {
  staffUser: {
    findUnique: async ({ where }) => { if (failDatabase) throw Error("Simulated database outage"); return where.id === account.id ? structuredClone(account) : null; },
    findFirst: async () => null,
    update: async ({ data }) => { writes++; Object.assign(account, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); return structuredClone(account); },
    findMany: async () => [structuredClone(account)],
    create: async ({ data }) => { writes++; return { ...data, id: "new-admin" }; },
  },
  pickupAppointment: {
    findMany: async ({ where }) => rows.filter(r => !where.locationId || where.locationId.in.includes(r.locationId)),
    findUnique: async ({ where }) => rows.find(r => r.id === where.id) ?? null,
    update: async () => { writes++; throw Error("Unexpected appointment mutation"); },
  },
};
const oldLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const resolved = request.startsWith(".") && parent ? path.resolve(path.dirname(parent.filename), request) : "";
  if (resolved === path.join(root, "src/lib/prisma")) return { prisma: db };
  if (parent?.filename.startsWith(path.join(root, "src"))) {
    if (request.endsWith("notifications/providers/email/sendEmail")) return { sendEmail: async () => { sends++; return { ok: true }; } };
    if (request === "../notifications") return new Proxy({}, { get: () => async () => { sends++; } });
    if (request.endsWith("createAcumaticaService")) return { createAcumaticaService() { throw Error("Unexpected ERP call"); } };
    if (request.endsWith("ingestOrderReadyDetails")) return { refreshOrderReadyDetails() { throw Error("Unexpected ERP call"); } };
    if (request.endsWith("refreshPrepayPayments")) return { refreshPrepayPaymentsIfNeeded() { throw Error("Unexpected ERP call"); } };
    if (request.endsWith("queue/erpClient")) return { shouldUseQueueErp: () => false, queueErpJobRequest() { throw Error("Unexpected queue call"); } };
  }
  return oldLoad.call(this, request, parent, isMain);
};
const app = express();
app.use(express.json());
app.use("/api/staff", require("../src/routes/staffAuth").staffAuthRouter);
app.use("/api/staff/users", require("../src/routes/staffUsers").staffUsersRouter);
app.use("/api/staff/pickups", require("../src/routes/pickups").pickupsRouter);
Module._load = oldLoad;
const staleToken = jwt.sign({ role: "ADMIN", locationAccess: allStores, email: account.email }, process.env.JWT_SECRET, { subject: account.id, expiresIn: "7d" });
let origin;
async function call(method, url, body, token = staleToken) {
  const res = await fetch(`${origin}${url}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const checks = [
  ["stale all-store admin token sees only current Boise appointments", async () => {
    const res = await call("GET", "/api/staff/pickups");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pickups.map(r => r.locationId), ["boise-willcall"]);
  }],
  ["explicit foreign-store query is forbidden", async () => assert.equal((await call("GET", "/api/staff/pickups?locationId=slc-hq")).status, 403)],
  ["foreign appointment details are forbidden", async () => assert.equal((await call("GET", "/api/staff/pickups/apt-0")).status, 403)],
  ["foreign appointment items are forbidden", async () => assert.equal((await call("GET", "/api/staff/pickups/apt-0/items")).status, 403)],
  ["foreign appointment edits are forbidden", async () => assert.equal((await call("PATCH", "/api/staff/pickups/apt-0", { customerPhone: "8015550100" })).status, 403)],
  ["foreign shipment edits are forbidden", async () => assert.equal((await call("PATCH", "/api/staff/pickups/apt-0/shipments", { shipments: [] })).status, 403)],
  ["foreign creation is forbidden before any ERP request", async () => assert.equal((await call("POST", "/api/staff/pickups", { locationId: "slc-hq", customerEmail: "test@example.invalid", customerFirstName: "Test" })).status, 403)],
  ["foreign availability is forbidden", async () => assert.equal((await call("GET", "/api/staff/pickups/availability?locationId=slc-hq&from=2099-10-27&to=2099-10-27")).status, 403)],
  ["foreign manual blocks cannot be changed", async () => assert.equal((await call("PATCH", "/api/staff/pickups/availability", { locationId: "slc-hq", changes: [{ date: "2099-10-27", startTime: "09:45", available: false }] })).status, 403)],
  ["own store detail remains accessible", async () => assert.equal((await call("GET", "/api/staff/pickups/apt-1")).status, 200)],
  ["moving an own-store appointment to a foreign store is forbidden", async () => assert.equal((await call("PATCH", "/api/staff/pickups/apt-1", { locationId: "slc-hq" })).status, 403)],
  ["every staff role is scoped to the assigned stores", async () => {
    for (const role of ["ADMIN", "STAFF", "VIEWER", "SALESPERSON"]) {
      account.role = role;
      const res = await call("GET", "/api/staff/pickups");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.pickups.map(r => r.locationId), ["boise-willcall"]);
    }
    account.role = "ADMIN";
  }],
  ["invalid and expired JWTs are still rejected", async () => {
    assert.equal((await call("GET", "/api/staff/me", undefined, "invalid-token")).status, 401);
    const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: account.id, expiresIn: -1 });
    assert.equal((await call("GET", "/api/staff/me", undefined, expired)).status, 401);
  }],
  ["me returns current permissions without caching", async () => {
    const res = await call("GET", "/api/staff/me");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user.locationAccess, ["boise-willcall"]);
    assert.equal(res.body.user.role, "ADMIN");
    assert.match(res.headers.get("cache-control"), /no-store/);
  }],
  ["admin location edits persist instead of expanding to every store", async () => {
    const res = await call("PATCH", `/api/staff/users/${account.id}`, { locationAccess: ["boise-willcall"] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user.locationAccess, ["boise-willcall"]);
  }],
  ["permission revocation applies on the next request using the SAME token", async () => {
    account.locationAccess = [];
    assert.deepEqual((await call("GET", "/api/staff/pickups")).body.pickups, []);
    assert.equal((await call("GET", "/api/staff/pickups/apt-1")).status, 403);
    account.locationAccess = ["boise-willcall"];
  }],
  ["role demotion prevents stale admin user-management access", async () => {
    account.role = "STAFF";
    assert.equal((await call("GET", "/api/staff/users")).status, 403);
    account.role = "ADMIN";
  }],
  ["disabled accounts are rejected even with an unexpired signed token", async () => {
    account.isActive = false;
    assert.equal((await call("GET", "/api/staff/pickups")).status, 401);
    account.isActive = true;
  }],
  ["database outage fails closed rather than trusting token permissions", async () => {
    failDatabase = true;
    assert.equal((await call("GET", "/api/staff/pickups")).status, 503);
    failDatabase = false;
  }],
  ["legacy SLC query cannot widen outlet-only permissions into HQ access", async () => {
    account.locationAccess = ["slc-outlet"];
    assert.equal((await call("GET", "/api/staff/pickups?locationId=slc")).status, 403);
    const res = await call("GET", "/api/staff/pickups");
    assert.deepEqual(res.body.pickups.map(r => r.locationId), ["slc-outlet"]);
    account.locationAccess = ["boise-willcall"];
  }],
  ["full-access admins keep all stores", async () => {
    account.locationAccess = allStores;
    assert.equal((await call("GET", "/api/staff/pickups")).body.pickups.length, rows.length);
    account.locationAccess = ["boise-willcall"];
  }],
];
(async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const log = console.log;
  console.info = console.warn = () => {};
  let failed = 0;
  try {
    for (const [name, check] of checks) {
      try { await check(); log(`PASS ${name}`); }
      catch (e) { failed++; log(`FAIL ${name}: ${e.message}`); }
    }
    assert.equal(sends, 0);
    assert.equal(writes, 1, "Only the explicit mocked user-edit test should write");
    log(`${checks.length - failed}/${checks.length} passed; zero notification calls`);
    process.exitCode = failed ? 1 : 0;
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
