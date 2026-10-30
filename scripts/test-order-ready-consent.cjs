// Offline integration tests: real mapper/schedulers, in-memory database and stubbed providers.
// Optional archived report: pipe JSON { rows: [...] } into --report-stdin. Never sends messages.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("ts-node").register({ transpileOnly: true });

const root = path.resolve(__dirname, "..");
const archivedRows = process.argv.includes("--report-stdin")
  ? JSON.parse(fs.readFileSync(0, "utf8")).rows
  : null;
if (archivedRows !== null) assert.ok(Array.isArray(archivedRows), "Expected archived rows array");

let clock, rawRows, db, sent, noticeWrites, activeAppointment, failEmail, failSms;
let queueMode = true, queueResponse, directResponse;
const NativeDate = Date;
class TestDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return new NativeDate(clock).getTime(); }
}

const sources = new Set([
  "src/lib/acumatica/fetch/fetchOrderReadyReport.ts",
  "src/notifications/orderReady/runOrderReadySync.ts",
  "src/notifications/orderReady/runOrderReadyEscalations.ts",
  "src/notifications/orderReady/syncState.ts",
]);
const loaded = new Map();
function load(relative) {
  if (loaded.has(relative)) return loaded.get(relative).exports;
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.set(relative, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  new Function("require", "exports", "module", "__filename", "__dirname", "Date", code)(
    mod.require.bind(mod), mod.exports, mod, filename, path.dirname(filename), TestDate
  );
  return mod.exports;
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename.startsWith(root) && request.startsWith(".")) {
    const absolute = path.resolve(path.dirname(parent.filename), request);
    const relative = path.relative(root, absolute).split(path.sep).join("/") + ".ts";
    if (sources.has(relative)) return load(relative);
    if (absolute.endsWith(path.join("queue", "erpClient"))) return {
      shouldUseQueueErp: () => queueMode,
      queueErpJobRequest: async () => queueResponse === undefined ? { rows: rawRows } : queueResponse,
    };
    if (absolute.endsWith(path.join("providers", "email", "sendEmail"))) return {
      sendEmail: async (to) => {
        sent.push({ channel: "email", to });
        if (failEmail) throw new Error("Simulated email failure");
        return { ok: true };
      },
    };
    if (absolute.endsWith(path.join("providers", "sms", "sendSms"))) return {
      sendSms: async (to) => {
        sent.push({ channel: "sms", to });
        if (failSms) throw new Error("Simulated SMS failure");
        return { ok: true };
      },
    };
    if (absolute.endsWith(path.join("links", "tokens"))) return {
      getActiveOrderReadyToken: async () => ({ token: "test-only" }),
      createOrderReadyToken: async () => ({ token: "test-only" }),
    };
    if (absolute.endsWith(path.join("rules", "quietHours"))) return { nextAllowedTime: (date) => date };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let fetchOrderReadyReport, runOrderReadySync, runOrderReadyEscalations;
try {
  ({ fetchOrderReadyReport } = load("src/lib/acumatica/fetch/fetchOrderReadyReport.ts"));
  ({ runOrderReadySync } = load("src/notifications/orderReady/runOrderReadySync.ts"));
  ({ runOrderReadyEscalations } = load("src/notifications/orderReady/runOrderReadyEscalations.ts"));
} finally { Module._load = originalLoad; }

// Even the direct OData path is mocked; no test may reach the network.
global.fetch = async () => {
  if (!queueMode && directResponse) return directResponse;
  throw new Error("Network access is blocked in consent tests");
};
process.env.FRONTEND_URL = "https://example.invalid/willcall";
process.env.ACUMATICA_USERNAME = "offline-test";
process.env.ACUMATICA_PASSWORD = "offline-test";
process.env.ACUMATICA_ORDER_READY_ODATA_URL = "https://example.invalid/odata";

function apply(row, data) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? (row[key] ?? 0) + value.increment : value;
  }
  return row;
}
function reset() {
  clock = "2026-10-30T15:30:35Z";
  rawRows = [];
  sent = [];
  noticeWrites = 0;
  activeAppointment = failEmail = failSms = false;
  queueMode = true;
  queueResponse = directResponse = undefined;
  const states = new Map(), notices = new Map();
  db = {
    states, notices,
    orderReadyJobState: {
      findUnique: async ({ where }) => states.get(where.name) ?? null,
      upsert: async ({ where, update, create }) => {
        const row = states.has(where.name) ? apply(states.get(where.name), update) : { ...create };
        states.set(where.name, row);
        return row;
      },
    },
    erpOrderSummary: { findMany: async () => [], findUnique: async () => null, findFirst: async () => null },
    staffUser: { findFirst: async () => ({ email: "sales@example.invalid", salespersonName: "Test" }) },
    pickupAppointmentOrder: { findFirst: async () => activeAppointment ? { appointmentId: "test-appointment" } : null },
    orderReadyNotice: {
      findUnique: async ({ where }) => notices.get(where.orderNbr) ?? null,
      upsert: async ({ where, update, create }) => {
        noticeWrites++;
        const row = notices.has(where.orderNbr) ? apply(notices.get(where.orderNbr), update) : { id: where.orderNbr, ...create };
        notices.set(where.orderNbr, row);
        return row;
      },
      update: async ({ where, data }) => { noticeWrites++; return apply(notices.get(where.id), data); },
      findMany: async ({ where }) => [...notices.values()].filter(n => where.orderNbr
        ? !where.orderNbr.notIn.includes(n.orderNbr)
        : n.notifyAttemptCount > where.notifyAttemptCount.gt && n.status !== "NotReady"),
      updateMany: async () => ({ count: 0 }),
    },
    orderReadyLine: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    orderReadyAccessToken: { updateMany: async () => ({ count: 0 }) },
  };
}
function sample(sms = "Opt-In", email = "Opt-In") {
  return {
    OrderNbr: "AUDIT-TEST", OrderType: "SO", Status: "Open", Customer: "TEST",
    Warehouse: "SALT LAKE APPLIANCES", ShipVia: "WILL CALL SL", InventoryID: "TEST",
    SMSOptin: sms, EmailOptin: email, TextNotification: "8015550100",
    EmailNotification: "customer@example.invalid", Salesperson1: "1234",
  };
}
const checks = [
  ["legacy booleans, strings, numeric values, nulls and wrappers remain supported", async () => {
    for (const [input, expected] of [
      [true, true], [false, false], ["true", true], ["false", false], [1, true], [0, false],
      ["yes", true], ["no", false], ["y", true], ["n", false], [null, null], ["", null], ["   ", null],
      [{ value: true }, true], [{ Value: false }, false], [{ "#text": "Opt-Out" }, false],
    ]) {
      rawRows = [sample(input, input)];
      const [row] = await fetchOrderReadyReport();
      assert.equal(row.attributeSmsOptIn, expected);
      assert.equal(row.attributeEmailOptIn, expected);
    }
  }],
  ["Opt-In and Opt-Out support whitespace, case and known label aliases", async () => {
    for (const [input, expected] of [[" OPT-IN ", true], ["Opt-Out", false], ["opt in", true], ["OPT OUT", false], ["optin", true], ["optout", false]]) {
      rawRows = [sample(input, input)];
      const [row] = await fetchOrderReadyReport();
      assert.equal(row.attributeSmsOptIn, expected);
      assert.equal(row.attributeEmailOptIn, expected);
    }
  }],
  ["validation summary reports opted-in, opted-out and unset row counts", async () => {
    rawRows = [sample(), sample("Opt-Out", "Opt-Out"), sample(null, null)];
    let summary;
    const previous = console.info;
    console.info = (message, data) => { if (message === "[order-ready] consent validation passed") summary = data; };
    try { await fetchOrderReadyReport(); } finally { console.info = previous; }
    assert.deepEqual(summary, { rows: 3,
      sms: { optedIn: 1, optedOut: 1, unset: 1 }, email: { optedIn: 1, optedOut: 1, unset: 1 } });
  }],
  ["both channels send and count as ONE outreach", async () => {
    rawRows = [sample()];
    await runOrderReadySync(db);
    assert.deepEqual(sent.map(x => x.channel), ["email", "sms"]);
    assert.equal(db.notices.get("AUDIT-TEST").notifyAttemptCount, 1);
  }],
  ["email-only and SMS-only use only the permitted channel", async () => {
    for (const [sms, email, channel] of [["Opt-Out", "Opt-In", "email"], ["Opt-In", "Opt-Out", "sms"]]) {
      reset(); rawRows = [sample(sms, email)];
      await runOrderReadySync(db);
      assert.deepEqual(sent.map(x => x.channel), [channel]);
    }
  }],
  ["both opted out sends nothing and does not mark notified", async () => {
    rawRows = [sample("Opt-Out", "Opt-Out")];
    await runOrderReadySync(db);
    assert.equal(sent.length, 0);
    assert.equal(db.notices.get("AUDIT-TEST").lastNotifiedAt, undefined);
  }],
  ["existing SMS opt-out still overrides the report opt-in", async () => {
    db.notices.set("AUDIT-TEST", { id: "AUDIT-TEST", orderNbr: "AUDIT-TEST", smsOptOutAt: new NativeDate(clock) });
    rawRows = [sample()];
    await runOrderReadySync(db);
    assert.deepEqual(sent.map(x => x.channel), ["email"]);
  }],
  ["email failure still attempts SMS and counts only one outreach", async () => {
    rawRows = [sample()]; failEmail = true;
    await runOrderReadySync(db);
    assert.deepEqual(sent.map(x => x.channel), ["email", "sms"]);
    assert.equal(db.notices.get("AUDIT-TEST").notifyAttemptCount, 1);
  }],
  ["failure of both providers does not mark notified or count an attempt", async () => {
    rawRows = [sample()]; failEmail = failSms = true;
    await runOrderReadySync(db);
    assert.equal(db.notices.get("AUDIT-TEST").notifyAttemptCount, 0);
    assert.equal(db.notices.get("AUDIT-TEST").lastNotifiedAt, undefined);
  }],
  ["same-day worker ticks do not repeat a successful sync", async () => {
    rawRows = [sample()];
    await runOrderReadySync(db); await runOrderReadySync(db);
    assert.equal(sent.length, 2);
  }],
  ["unknown consent rejects the WHOLE batch before notice writes or sends", async () => {
    for (const invalid of ["Maybe", 2, {}, [], "opt-unknown"]) {
      reset(); rawRows = [sample(), { ...sample(invalid), OrderNbr: "BAD" }];
      await assert.rejects(() => runOrderReadySync(db), /consent validation failed/);
      assert.equal(noticeWrites, 0); assert.equal(sent.length, 0);
      assert.equal(db.states.get("order-ready-daily").status, "failed");
    }
  }],
  ["missing either consent column rejects the report before notice writes", async () => {
    for (const field of ["SMSOptin", "EmailOptin"]) {
      reset(); const row = sample(); delete row[field]; rawRows = [row];
      await assert.rejects(() => runOrderReadySync(db), /missing/);
      assert.equal(noticeWrites, 0); assert.equal(sent.length, 0);
    }
  }],
  ["malformed rows cannot masquerade as valid report records", async () => {
    for (const invalid of [null, "bad-row", []]) {
      reset(); rawRows = [sample(), invalid];
      await assert.rejects(() => runOrderReadySync(db), /row 2 must be an object/);
      assert.equal(noticeWrites, 0); assert.equal(sent.length, 0);
    }
  }],
  ["malformed queue envelope fails rather than becoming an empty report", async () => {
    queueResponse = {};
    await assert.rejects(() => runOrderReadySync(db), /rows array/);
    assert.equal(noticeWrites, 0); assert.equal(sent.length, 0);
  }],
  ["direct OData supports array and value-array envelopes", async () => {
    queueMode = false;
    for (const payload of [[sample()], { value: [sample()] }]) {
      directResponse = { ok: true, json: async () => payload };
      assert.equal((await fetchOrderReadyReport())[0].attributeEmailOptIn, true);
    }
  }],
  ["malformed direct OData and invalid JSON fail closed", async () => {
    queueMode = false;
    directResponse = { ok: true, json: async () => ({}) };
    await assert.rejects(() => runOrderReadySync(db), /OData response/);
    directResponse = { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } };
    await assert.rejects(() => runOrderReadySync(db), /Invalid JSON/);
    assert.equal(noticeWrites, 0); assert.equal(sent.length, 0);
  }],
  ["legitimate empty reports remain supported", async () => {
    rawRows = [];
    await runOrderReadySync(db);
    assert.equal(db.states.get("order-ready-daily").status, "success");
    assert.equal(db.states.get("order-ready-daily").rowCount, 0);
  }],
  ["9:45 escalation skips a failed 9:30 sync", async () => {
    rawRows = [sample("Invalid")];
    await assert.rejects(() => runOrderReadySync(db));
    clock = "2026-10-30T15:45:00Z";
    await runOrderReadyEscalations(db);
    assert.equal(sent.length, 0);
    assert.equal(db.states.get("order-ready-escalation-daily").status, "skipped");
  }],
  ["yesterday's successful sync cannot authorize today's escalation", async () => {
    db.states.set("order-ready-daily", { businessDate: "2026-10-29", status: "success", completedAt: new NativeDate("2026-10-29T15:32:00Z") });
    clock = "2026-10-30T15:45:00Z";
    await runOrderReadyEscalations(db);
    assert.equal(sent.length, 0);
    assert.equal(db.states.get("order-ready-escalation-daily").status, "skipped");
  }],
  ["escalation requires SIX attempts, not five", async () => {
    rawRows = [sample()]; await runOrderReadySync(db); sent = [];
    clock = "2026-10-30T15:45:00Z";
    db.notices.get("AUDIT-TEST").notifyAttemptCount = 5;
    await runOrderReadyEscalations(db); assert.equal(sent.length, 0);
    db.states.delete("order-ready-escalation-daily");
    db.notices.get("AUDIT-TEST").notifyAttemptCount = 6;
    await runOrderReadyEscalations(db);
    assert.deepEqual(sent.map(x => x.to), ["sales@example.invalid"]);
  }],
  ["active appointments suppress salesperson escalation", async () => {
    rawRows = [sample()]; await runOrderReadySync(db); sent = [];
    db.notices.get("AUDIT-TEST").notifyAttemptCount = 6; activeAppointment = true;
    clock = "2026-10-30T15:45:00Z";
    await runOrderReadyEscalations(db);
    assert.equal(sent.length, 0);
    assert.equal(db.notices.get("AUDIT-TEST").notifyAttemptCount, 0);
  }],
  ["Monday after DST: sync waits for 16:30 UTC = 9:30 Denver", async () => {
    rawRows = [sample()]; clock = "2026-11-02T16:29:00Z";
    await runOrderReadySync(db); assert.equal(sent.length, 0);
    clock = "2026-11-02T16:30:00Z";
    await runOrderReadySync(db); assert.equal(sent.length, 2);
    assert.equal(db.states.get("order-ready-daily").businessDate, "2026-11-02");
  }],
  ["Monday after DST: escalation waits for 16:45 UTC = 9:45 Denver", async () => {
    rawRows = [sample()]; clock = "2026-11-02T16:30:00Z";
    await runOrderReadySync(db); sent = [];
    db.notices.get("AUDIT-TEST").notifyAttemptCount = 6;
    clock = "2026-11-02T16:44:00Z";
    await runOrderReadyEscalations(db); assert.equal(sent.length, 0);
    clock = "2026-11-02T16:45:00Z";
    await runOrderReadyEscalations(db);
    assert.deepEqual(sent.map(x => x.to), ["sales@example.invalid"]);
  }],
  ["weekend runs stay suppressed", async () => {
    rawRows = [sample()]; clock = "2026-11-01T16:45:00Z";
    await runOrderReadySync(db); await runOrderReadyEscalations(db);
    assert.equal(sent.length, 0); assert.equal(db.states.size, 0);
  }],
];
if (archivedRows) checks.push(["archived report replay uses the actual mapper and sync", async () => {
  rawRows = archivedRows;
  const mapped = await fetchOrderReadyReport();
  assert.equal(mapped.length, archivedRows.length);
  for (let i = 0; i < mapped.length; i++) {
    for (const [rawKey, mappedKey] of [["SMSOptin", "attributeSmsOptIn"], ["EmailOptin", "attributeEmailOptIn"]]) {
      if (archivedRows[i][rawKey] === "Opt-In") assert.equal(mapped[i][mappedKey], true);
      if (archivedRows[i][rawKey] === "Opt-Out") assert.equal(mapped[i][mappedKey], false);
    }
  }
  await runOrderReadySync(db);
  assert.equal(db.states.get("order-ready-daily").status, "success");
  assert.equal(db.notices.size, new Set(mapped.map(r => r.orderNbr?.trim()).filter(Boolean)).size);
  results.push({ replay: { rows: mapped.length, orders: db.notices.size,
    emailAttempts: sent.filter(x => x.channel === "email").length,
    smsAttempts: sent.filter(x => x.channel === "sms").length } });
}]);

const results = [];
(async () => {
  const oldConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = () => {};
  let failed = 0;
  try {
    for (const [name, run] of checks) {
      reset();
      try { await run(); results.push({ test: name, status: "PASS" }); }
      catch (error) { failed++; results.push({ test: name, status: "FAIL", error: error.message }); }
    }
  } finally { Object.assign(console, oldConsole); }
  for (const result of results) console.log(JSON.stringify(result));
  console.log(JSON.stringify({ passed: checks.length - failed, total: checks.length,
    productionWrites: 0, realNotificationsSent: 0, providersAndDatabaseMocked: true }));
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
