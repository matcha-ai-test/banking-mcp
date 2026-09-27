import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { z } from "zod";
import { createEnv, mockEnableBanking } from "./helpers.mjs";

const { Db } = await import("../src/db.ts");
const { matchAccountUids } = await import("../src/util.ts");
const { EbClient } = await import("../src/eb.ts");
const { readTransactionDetails, sanitizeTransactionDetails } = await import("../src/transaction-details.ts");
const NOW = Date.parse("2030-01-01T12:00:00Z");
const INPUT = { booking_date: "2030-01-01", amount: -12.34 };
const IBAN = "ZZ0000000000001234";
const EXPECTED_IBAN = "•••• 1234";
const RAW = {
  transaction_id: "detail-id", booking_date: INPUT.booking_date, value_date: "2029-12-31",
  transaction_amount: { amount: "12.34", currency: "EUR" }, credit_debit_indicator: "DBIT",
  status: "BOOK", remittance_information: ["Account holder"], debtor: null, note: null,
  creditor_account: { iban: IBAN, other: { identification: "hidden-account" } },
  debtor_account: { iban: IBAN }, secret: "hidden-top-level",
};
const DETAIL = { ...RAW, debtor: { name: "Example payer", postal_address: "hidden-address" },
  creditor: { name: "Example payee" }, note: "Example note", reference_number: "example-ref",
  merchant_category_code: "1234", bank_transaction_code: { description: "Credit transfer", code: "hidden-code" },
};

function row(key = "one", raw = RAW, account = "account") {
  return { account_uid: account, booking_date: INPUT.booking_date, value_date: "2029-12-31",
    amount_cents: 1234, currency: "EUR", credit_debit: "DBIT", counterparty: null,
    remittance_info: "Account holder", entry_reference: key, dedup_key: key,
    raw: raw === null ? null : JSON.stringify(raw) };
}

async function setup(t, routes = { "GET /accounts/account/transactions/detail-id": DETAIL }) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const db = new Db(env);
  for (const id of ["selected", "other"]) {
    await db.insertSession({ id, session_id: `upstream-${id}`, psu_type: "personal",
      aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2099-01-01T00:00:00Z" });
    await db.upsertAccounts([{ account_uid: id === "selected" ? "account" : "other-account",
      session_pk: id, name: id === "selected" ? "Primary" : "Secondary", iban: null,
      currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
  }
  await db.insertTransactionsIgnore([row()]);
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  const bumps = [];
  const charge = db.tryChargeRefreshBudget.bind(db);
  db.tryChargeRefreshBudget = async (...args) => {
    const result = await charge(...args);
    if (result.charged) bumps.push(args);
    return result;
  };
  return { env, db, mock, bumps, read: (input = INPUT, uids = null) =>
    readTransactionDetails(db, () => new EbClient(env), input, uids, NOW) };
}

function snapshot(env) {
  return Object.fromEntries(["transactions", "pending_transactions", "accounts", "balances", "sync_log"]
    .map((table) => [table, env.DB.sqlite.prepare(`SELECT * FROM ${table}`).all()]));
}

test("DB matcher resolves signed date/amount and ID, with account scope and bound parameters", async (t) => {
  const { db, mock } = await setup(t);
  await db.insertTransactionsIgnore([
    { ...row("credit", { ...RAW, transaction_id: "credit-id" }), credit_debit: "CRDT" },
    row("other", { ...RAW, transaction_id: "other-id" }, "other-account"),
    { ...row("negative-storage", { ...RAW, transaction_id: "negative-id" }), amount_cents: -1234, booking_date: "2029-12-30" },
  ]);
  const match = (opts) => db.findTransactionDetails({ bookingDate: INPUT.booking_date, amountCents: -1234, ...opts });
  assert.deepEqual((await match({ accountUids: ["account"] })).map((r) => r.dedup_key), ["one"]);
  assert.deepEqual((await match({ amountCents: 1234 })).map((r) => r.dedup_key), ["credit"]);
  assert.equal((await match({ bookingDate: "2029-12-30" }))[0].dedup_key, "negative-storage");
  assert.equal((await match({ transactionId: "detail-id", bookingDate: "1999-01-01", amountCents: 999 }))[0].dedup_key, "one");
  assert.deepEqual(await match({ transactionId: "detail-id", accountUids: ["other-account"] }), []);
  assert.deepEqual(await match({ transactionId: "detail-id", accountUids: [] }), []);
  assert.deepEqual(await match({ transactionId: "' OR 1=1 --" }), []);
  assert.equal(mock.calls.length, 0);
});

test("ID lookup skips malformed and NULL raw rows beside a valid match", async (t) => {
  const { db, read, mock } = await setup(t);
  await db.insertTransactionsIgnore([
    { ...row("malformed"), raw: "{invalid JSON" }, row("null", null),
  ]);
  assert.deepEqual((await db.findTransactionDetails({ transactionId: "detail-id",
    bookingDate: INPUT.booking_date, amountCents: -1234 })).map((r) => r.dedup_key), ["one"]);
  assert.equal((await read({ ...INPUT, transaction_id: "detail-id" })).amount, -12.34);
  assert.deepEqual(await read({ ...INPUT, transaction_id: "missing" }), { error: "No cached transaction matches" });
  assert.equal(mock.calls.length, 1);
});

for (const secret of ["EB_APP_ID", "EB_PRIVATE_KEY"]) {
  test(`client construction with missing ${secret} does not charge or dispatch`, async (t) => {
    const { env, read, mock, bumps } = await setup(t);
    delete env[secret];
    const before = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all();
    assert.deepEqual(await read(), { error: "client_not_configured" });
    assert.deepEqual(bumps, []);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all(), before);
  });
}

test("two concurrent distinct details with one slot left dispatch and charge exactly once", async (t) => {
  const { env, db, read, mock, bumps } = await setup(t, {
    "GET /accounts/account/transactions/detail-id": DETAIL,
    "GET /accounts/account/transactions/second-id": DETAIL,
  });
  await db.insertTransactionsIgnore([row("second", { ...RAW, transaction_id: "second-id" })]);
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 1, refresh_count_date = '2030-01-01' WHERE id = 'selected'").run();
  // Hold both callers at the real atomic update so they compete for the last slot.
  const charge = db.tryChargeRefreshBudget.bind(db);
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  db.tryChargeRefreshBudget = async (...args) => {
    if (++arrived === 2) release();
    await ready;
    return charge(...args);
  };
  const results = await Promise.all([read({ ...INPUT, transaction_id: "detail-id" }), read({ ...INPUT, transaction_id: "second-id" })]);
  assert.equal(results.filter((r) => r.debtor_name === "Example payer").length, 1);
  assert.deepEqual(results.find((r) => r.error), {
    error: "Daily refresh budget (2) used; serving cached data. Budget resets at midnight UTC.", budget_left_today: 0,
  });
  assert.ok(results.every((r) => r.budget_left_today === 0));
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(bumps, [["selected", "2030-01-01", 2]]);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 2);
});

test("repeated failed HTTP attempts consume the budget and then stop dispatching", async (t) => {
  const { env, read, mock, bumps } = await setup(t, {
    "GET /accounts/account/transactions/detail-id": () => new Response("unavailable", { status: 503 }),
  });
  for (let n = 1; n <= 2; n++) {
    assert.deepEqual(await read(), { error: "transaction_details_failed" });
    assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, n);
  }
  assert.equal((await read()).budget_left_today, 0);
  assert.equal(mock.calls.length, 2);
  assert.equal(bumps.length, 2);
});

test("no match returns the exact error without a bank call", async (t) => {
  const { read, mock, bumps } = await setup(t);
  assert.deepEqual(await read({ ...INPUT, amount: 99 }), { error: "No cached transaction matches" });
  assert.deepEqual(await read({ ...INPUT, transaction_id: "missing" }), { error: "No cached transaction matches" });
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(bumps, []);
});

test("ambiguous date/amount returns only candidates; ID selects one", async (t) => {
  const { db, read, mock, bumps } = await setup(t);
  await db.insertTransactionsIgnore([row("two", { ...RAW, transaction_id: "second-id" })]);
  const result = await read();
  assert.match(result.error, /pass transaction_id/);
  assert.deepEqual(result.candidates, ["second-id", "detail-id"].map((transaction_id) => ({
    date: INPUT.booking_date, amount: -12.34, description: "Account holder", transaction_id,
  })));
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(bumps, []);
  assert.equal((await read({ ...INPUT, transaction_id: "detail-id" })).debtor_name, "Example payer");
  assert.equal(mock.calls.length, 1);
});

test("duplicate IDs across accounts stay ambiguous until account scope is supplied", async (t) => {
  const { db, read, mock } = await setup(t);
  await db.insertTransactionsIgnore([row("two", RAW, "other-account")]);
  const input = { ...INPUT, transaction_id: "detail-id" };
  assert.equal((await read(input)).candidates.length, 2);
  assert.equal(mock.calls.length, 0);
  assert.equal((await read(input, ["account"])).amount, -12.34);
  assert.equal(mock.calls.length, 1);
});

for (const raw of [null, { ...RAW, transaction_id: null }, { ...RAW, transaction_id: "" }]) {
  test(`missing ID returns sanitized cached fields without constructing a client: ${raw === null ? "null raw" : String(raw.transaction_id)}`, async (t) => {
    const { db, env, mock, bumps } = await setup(t);
    env.DB.sqlite.prepare("UPDATE transactions SET raw = ?").run(raw === null ? null : JSON.stringify(raw));
    const before = snapshot(env);
    const result = await readTransactionDetails(db, () => { throw new Error("must not construct"); }, INPUT, null, NOW);
    assert.equal(result.error, "This bank did not provide a transaction_id; no additional details are available");
    assert.equal(result.cached.amount, -12.34);
    assert.equal(result.cached.booking_date, INPUT.booking_date);
    assert.equal(/hidden-|transaction_id/.test(JSON.stringify(result.cached)), false);
    assert.equal(result.cached.creditor_account_iban, raw === null ? null : EXPECTED_IBAN);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(bumps, []);
    assert.deepEqual(snapshot(env), before);
  });
}

test("exhausted owning session budget blocks HTTP; another session's budget is irrelevant", async (t) => {
  const { env, read, mock, bumps } = await setup(t);
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 2, refresh_count_date = '2030-01-01' WHERE id = 'selected'").run();
  assert.deepEqual(await read(), {
    error: "Daily refresh budget (2) used; serving cached data. Budget resets at midnight UTC.", budget_left_today: 0,
  });
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(bumps, []);
});

test("success uses one GET, bumps only its session once, sanitizes both records, and caches detail for a free second lookup", async (t) => {
  const { env, read, mock, bumps } = await setup(t);
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 0, refresh_count_date = '2030-01-01' WHERE id = 'selected'").run();
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 2, refresh_count_date = '2030-01-01' WHERE id = 'other'").run();
  const before = snapshot(env);
  const result = await read();
  const expected = {
    booking_date: INPUT.booking_date, value_date: "2029-12-31", amount: -12.34, currency: "EUR", status: "BOOK",
    remittance_information: ["Account holder"], creditor_name: "Example payee", debtor_name: "Example payer",
    creditor_account_iban: EXPECTED_IBAN, debtor_account_iban: EXPECTED_IBAN, note: "Example note",
    bank_transaction_code: { description: "Credit transfer" }, reference_number: "example-ref", merchant_category_code: "1234",
  };
  assert.deepEqual(result, { ...expected, list_row: { ...expected, creditor_name: null, debtor_name: null,
    note: null, bank_transaction_code: { description: null }, reference_number: null, merchant_category_code: null }, budget_left_today: 1 });
  assert.equal(JSON.stringify(result).includes("hidden-"), false);
  assert.deepEqual(bumps, [["selected", "2030-01-01", 2]]);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 1);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'other'").get().n, 2);
  assert.deepEqual(mock.calls.map(({ method, path }) => ({ method, path })), [{ method: "GET", path: "/accounts/account/transactions/detail-id" }]);
  const stored = snapshot(env);
  assert.deepEqual(JSON.parse(stored.transactions[0].raw), { ...RAW, detail: DETAIL });
  assert.ok(stored.transactions[0].detail_fetched_at);
  before.transactions[0].raw = stored.transactions[0].raw;
  before.transactions[0].detail_fetched_at = stored.transactions[0].detail_fetched_at;
  assert.deepEqual(stored, before);
  const { budget_left_today, ...cached } = result;
  assert.deepEqual(await read(), { ...cached, cached_detail: true });
  assert.equal(mock.calls.length, 1);
  assert.equal(bumps.length, 1);
});

test("UTC day rollover restores budget and banks may return the unchanged list record", async (t) => {
  const { env, read, bumps } = await setup(t, { "GET /accounts/account/transactions/detail-id": RAW });
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 2, refresh_count_date = '2029-12-31'").run();
  const { list_row, budget_left_today, ...detail } = await read();
  assert.deepEqual(detail, list_row);
  assert.equal(budget_left_today, 1);
  assert.deepEqual(bumps, [["selected", "2030-01-01", 2]]);
});

for (const [status, body, expected] of [
  [503, "sensitive-upstream-body", "transaction_details_failed"],
  [403, "sensitive-upstream-body", "transaction_details_failed"],
  [429, "sensitive-upstream-body", "rate_limited"],
  [400, "EXPIRED_SESSION sensitive-upstream-body", "expired_session"],
]) {
  test(`HTTP ${status} has no retry, returns only a safe code, and keeps exactly one charge`, async (t) => {
    const { read, mock, env, bumps } = await setup(t, {
      "GET /accounts/account/transactions/detail-id": () => {
        assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 1);
        return new Response(body, { status });
      },
    });
    const before = snapshot(env);
    assert.deepEqual(await read(), { error: expected });
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(bumps, [["selected", "2030-01-01", 2]]);
    assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 1);
    assert.deepEqual(snapshot(env), before);
  });
}

test("network exception messages never reach callers", async (t) => {
  const { read, mock, env, bumps } = await setup(t, {
    "GET /accounts/account/transactions/detail-id": () => { throw new Error("sensitive-upstream-body"); },
  });
  assert.deepEqual(await read(), { error: "transaction_details_failed" });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(bumps, [["selected", "2030-01-01", 2]]);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 1);
});

test("inactive owning session never fetches through another active session", async (t) => {
  const { env, read, mock, bumps } = await setup(t);
  env.DB.sqlite.prepare("UPDATE eb_sessions SET status = 'expired' WHERE id = 'selected'").run();
  assert.deepEqual(await read(), { error: "no_active_session" });
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(bumps, []);
});

test("nested non-scalar payloads are not copied and credit amounts are positive", () => {
  const hidden = { secret: "hidden-value" };
  const result = sanitizeTransactionDetails({ ...DETAIL, note: hidden, creditor: { name: hidden },
    debtor_account: { iban: hidden }, bank_transaction_code: { description: hidden },
    remittance_information: ["Allowed", hidden, 123], transaction_amount: { amount: "-12.34", currency: "EUR" },
    credit_debit_indicator: "CRDT" });
  assert.equal(result.amount, 12.34);
  assert.deepEqual(result.remittance_information, ["Allowed"]);
  assert.equal(result.note, null);
  assert.equal(result.creditor_name, null);
  assert.equal(result.debtor_account_iban, null);
  assert.deepEqual(result.bank_transaction_code, { description: null });
  assert.equal(JSON.stringify(result).includes("hidden-"), false);
});

test("API detail encodes both identifiers as single path segments", async (t) => {
  const account = "account/with?query#fragment% &å";
  const transaction = "transaction/with?query#fragment% &å";
  const path = `/accounts/${encodeURIComponent(account)}/transactions/${encodeURIComponent(transaction)}`;
  const { env, mock } = await setup(t, { [`GET ${path}`]: DETAIL });
  assert.deepEqual(await new EbClient(env).getTransactionDetail(account, transaction), DETAIL);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].path, path);
  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].search.size, 0);
});

test("MCP registration follows get_transactions, validates input and uses the existing account resolver", async (t) => {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf('      "get_transaction_details",');
  assert.ok(start > source.indexOf('      "get_transactions",'));
  assert.ok(start < source.indexOf('      "export_statements",'));
  assert.equal(source.split('      "get_transaction_details",').length, 2);
  const handlerStart = source.indexOf("      async (", start);
  const config = source.slice(start + '      "get_transaction_details",'.length, handlerStart).trim().replace(/,$/, "");
  const { description, inputSchema } = Function("z", `return (${config})`)(z);
  assert.ok(description.split(/\s+/).length <= 60);
  const schema = z.object(inputSchema);
  assert.equal(schema.safeParse(INPUT).success, true);
  for (const input of [{}, { ...INPUT, booking_date: "2030-02-30" }, { ...INPUT, amount: "12.34" }, { ...INPUT, transaction_id: "" }]) {
    assert.equal(schema.safeParse(input).success, false);
  }
  const body = source.slice(handlerStart, source.indexOf("\n    );", handlerStart)).trim()
    .replace(/^async \(([^)]*)\) =>/, "async function($1)");
  const handle = Function("readTransactionDetails", "EbClient", `return (${body})`)(readTransactionDetails, EbClient);
  const { db, env, mock } = await setup(t);
  // Execute the actual resolver method and matchAccountUids against real Db rows.
  const resolverStart = source.indexOf("  private async resolveAccountUids(");
  const resolverBody = source.slice(resolverStart, source.indexOf("\n  }", resolverStart) + 4)
    .trim().replace("private async resolveAccountUids", "async function");
  const resolveAccountUids = Function("matchAccountUids", `return ${stripTypeScriptTypes(`(${resolverBody})`)}`)(matchAccountUids);
  await db.insertTransactionsIgnore([row("duplicate", RAW, "other-account")]);
  const self = { db: () => db, cfg: env, text: (_warning, data) => data, resolveAccountUids };
  const result = await handle.call(self, { ...INPUT, account: "Primary" });
  assert.equal(result.debtor_name, "Example payer");
  assert.deepEqual(await handle.call(self, { ...INPUT, account: "Missing" }), { error: "No cached transaction matches" });
  assert.equal(mock.calls.length, 1);
});

for (const key of ["invalid synthetic key", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"]) {
  test(`token preparation rejects ${key.split("\n")[0]} without a charge or HTTP`, async (t) => {
    const { env, read, mock, bumps } = await setup(t);
    env.EB_PRIVATE_KEY = key;
    const before = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all();
    assert.deepEqual(await read(), { error: "key_invalid" });
    assert.deepEqual(bumps, []);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all(), before);
  });
}

test("prepare caches the JWT without HTTP, and dispatch reuses it", async (t) => {
  const { env, mock } = await setup(t);
  const client = new EbClient(env);
  await client.prepare();
  assert.equal(mock.calls.length, 0);
  // A second mint would fail; the subsequent request must use the cached token.
  client.privateKey = "invalid synthetic key";
  await client.prepare();
  await client.getTransactionDetail("account", "detail-id");
  assert.equal(mock.calls.length, 1);
});

test("NULL budget date resets an exhausted stored count before a detail request", async (t) => {
  const { env, read, mock } = await setup(t);
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 9, refresh_count_date = NULL WHERE id = 'selected'").run();
  assert.equal((await read()).budget_left_today, 1);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 1);
  assert.equal(mock.calls.length, 1);
});

test("concurrent successful details report their own RETURNING counts: 1 then 0 left", async (t) => {
  const { env, db, read, mock } = await setup(t, {
    "GET /accounts/account/transactions/detail-id": DETAIL,
    "GET /accounts/account/transactions/second-id": DETAIL,
  });
  await db.insertTransactionsIgnore([row("second", { ...RAW, transaction_id: "second-id" })]);
  const charge = db.tryChargeRefreshBudget.bind(db);
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  db.tryChargeRefreshBudget = async (...args) => {
    if (++arrived === 2) release();
    await ready;
    return charge(...args);
  };
  const results = await Promise.all([read({ ...INPUT, transaction_id: "detail-id" }), read({ ...INPUT, transaction_id: "second-id" })]);
  assert.deepEqual(results.map((r) => r.budget_left_today).sort().reverse(), [1, 0]);
  assert.equal(mock.calls.length, 2);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions WHERE id = 'selected'").get().n, 2);
});

for (const phase of ["prepare", "charge"]) {
  test(`detail tool rechecks persisted enrichment after ${phase}`, async t => {
    const { env, db, bumps, mock } = await setup(t);
    const originalRow = snapshot(env).transactions[0];
    const complete = () => db.storeTransactionDetail(originalRow, DETAIL);
    if (phase === "charge") {
      const charge = db.tryChargeRefreshBudget.bind(db);
      db.tryChargeRefreshBudget = async (...args) => {
        const result = await charge(...args);
        await complete();
        return result;
      };
    }
    const result = await readTransactionDetails(db, () => ({
      prepare: async () => { if (phase === "prepare") await complete(); },
      getTransactionDetail: () => { throw new Error("cached row must not dispatch"); },
    }), INPUT, null, NOW);
    assert.equal(result.cached_detail, true);
    assert.equal(result.debtor_name, "Example payer");
    assert.equal(mock.calls.length, 0);
    assert.equal(bumps.length, phase === "prepare" ? 0 : 1);
  });
}

for (const marker of ["timestamp", "raw.detail"]) {
  test(`detail tool serves persisted ${marker} without charging`, async t => {
    const { env, db, bumps, mock } = await setup(t);
    env.DB.sqlite.exec(marker === "timestamp"
      ? "UPDATE transactions SET detail_fetched_at = '2030-01-01'"
      : "UPDATE transactions SET raw = json_set(raw, '$.detail', json('{}'))");
    const result = await readTransactionDetails(db, () => { throw new Error("must not construct client"); }, INPUT, null, NOW);
    assert.equal(result.cached_detail, true);
    assert.equal(mock.calls.length, 0);
    assert.equal(bumps.length, 0);
  });
}

test("concurrent detail writers persist once and both return the winner's detail", async t => {
  const { env, db } = await setup(t);
  const originalRow = snapshot(env).transactions[0];
  const competingDb = new Db(env);
  let arrived = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const prepare = env.DB.prepare;
  const writes = [];
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes("UPDATE transactions SET")) return statement;
    return { bind: (...params) => ({ run: async () => {
      if (++arrived === 2) release();
      await ready;
      const result = await statement.bind(...params).run();
      writes.push(result.meta.changes);
      return result;
    } }) };
  };
  const results = await Promise.all([
    db.storeTransactionDetail(originalRow, DETAIL),
    competingDb.storeTransactionDetail(originalRow, { ...DETAIL, remittance_information: ["Other detail"] }),
  ]);
  assert.deepEqual(writes.sort(), [0, 1]);
  const winner = JSON.parse(snapshot(env).transactions[0].raw).detail;
  assert.deepEqual(results, [winner, winner]);
});

test("detail tool returns the concurrent persistence winner rather than its HTTP payload", async t => {
  const { env, db, read } = await setup(t, {
    "GET /accounts/account/transactions/detail-id": async () => {
      await db.storeTransactionDetail(snapshot(env).transactions[0], { ...DETAIL, note: "Winner" });
      return { ...DETAIL, note: "Loser" };
    },
  });
  assert.equal((await read()).note, "Winner");
  assert.equal(JSON.parse(snapshot(env).transactions[0].raw).detail.note, "Winner");
});

test("active detail claim times out without a budget charge or HTTP", async t => {
  const { env, db, read, mock, bumps } = await setup(t);
  const original = snapshot(env).transactions[0];
  assert.equal(await db.claimTransactionDetail(original.id, new Date(NOW).toISOString(), new Date(NOW - 120_000).toISOString()), true);
  const start = Date.now();
  assert.deepEqual(await read(), { error: "detail_fetch_in_progress" });
  assert.ok(Date.now() - start >= 2900);
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(bumps, []);
});

test("tool takes over stale claim and old owner cannot release the new claim", async t => {
  const { env, db, read, mock } = await setup(t);
  const original = snapshot(env).transactions[0];
  const old = new Date(NOW - 121_000).toISOString();
  const cutoff = new Date(NOW - 120_000).toISOString();
  assert.equal(await db.claimTransactionDetail(original.id, old, cutoff), true);
  assert.equal(await db.claimTransactionDetail(original.id, cutoff, cutoff), true);
  await db.releaseTransactionDetailClaim(original.id, old);
  assert.equal(snapshot(env).transactions[0].detail_claimed_at, cutoff);
  // Equality is not stale; only claims strictly older than the cutoff qualify.
  assert.equal(await db.claimTransactionDetail(original.id, new Date(NOW).toISOString(), cutoff), false);
  env.DB.sqlite.prepare("UPDATE transactions SET detail_claimed_at = ?").run(old);
  assert.equal((await read()).debtor_name, "Example payer");
  assert.equal(mock.calls.length, 1);
  assert.equal(snapshot(env).transactions[0].detail_claimed_at, null);
  assert.equal(await db.claimTransactionDetail(original.id, new Date(NOW).toISOString(), cutoff), false);
});
