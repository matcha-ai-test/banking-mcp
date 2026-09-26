import assert from "node:assert/strict";
import test from "node:test";
import { createEnv, mockEnableBanking } from "./helpers.mjs";
const { Db } = await import("../src/db.ts");
const { EbClient } = await import("../src/eb.ts");
const { syncAccount, syncAll, backfillAccounts, previewEnrichmentCandidates, enrichmentPolicyFromEnv,
  ENRICH_MAX_PER_ACCOUNT, ENRICH_MAX_PER_SESSION, ENRICH_BACKFILL_DAYS } = await import("../src/sync.ts");
const { daysAgo } = await import("../src/util.ts");
const { readTransactionDetails, sanitizeTransactionDetails } = await import("../src/transaction-details.ts");

function transaction(id, text = ["Account Holder"], extra = {}) {
  return { transaction_id: id, entry_reference: `ref-${id}`, booking_date: "2030-01-01",
    value_date: "2029-12-31", transaction_amount: { amount: "12.34", currency: "EUR" },
    credit_debit_indicator: "CRDT", status: "BOOK", remittance_information: text, ...extra };
}
const detail = transaction("detail", ["Example payer"], { debtor: { name: "Payer name" },
  secret: "hidden-value", debtor_account: { iban: "ZZ0000000000001234" } });

async function setup(t, rows, { accounts = 1, sessions = 1, reply = detail } = {}) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const db = new Db(env);
  const routes = {};
  for (let s = 0; s < sessions; s++) {
    await db.insertSession({ id: `session-${s}`, session_id: `upstream-${s}`, psu_type: "personal",
      aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2099-01-01T00:00:00Z" });
    for (let a = 0; a < accounts; a++) {
      const uid = `account-${s}-${a}`;
      await db.upsertAccounts([{ account_uid: uid, session_pk: `session-${s}`, name: "  Account   Holder  ",
        iban: null, currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
      routes[`GET /accounts/${uid}/transactions`] = { transactions: rows };
      routes[`GET /accounts/${uid}/balances`] = { balances: [] };
      for (const row of rows) routes[`GET /accounts/${uid}/transactions/${row.transaction_id}`] = reply;
    }
  }
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  const account = (await db.allAccounts()).find(a => a.account_uid === "account-0-0");
  return { env, db, routes, mock, account, sync: (opts) => syncAccount(db, new EbClient(env), account, opts),
    stored: () => env.DB.sqlite.prepare("SELECT * FROM transactions ORDER BY account_uid, booking_date DESC, id DESC").all(),
    detailCalls: () => mock.calls.filter(c => /\/transactions\//.test(c.path)) };
}

for (const [name, text, extra, expected] of [
  ["own name normalized", ["  ACCOUNT", "  holder  "], {}, 1],
  ["empty", [], {}, 1], ["blank", ["   "], {}, 1],
  ["missing text", undefined, {}, 1], ["digits and spaces", ["1234  5678"], {}, 1],
  ["merchant", ["Example shop"], {}, 0], ["mixed reference", ["123ABC"], {}, 0],
  ["no transaction ID", [], { transaction_id: null }, 0],
  ["pending", [], { status: "PDNG" }, 0],
]) {
  test(`candidate: ${name}`, async t => {
    const row = transaction("one", text, extra);
    if (name === "missing text") delete row.remittance_information;
    const { sync, detailCalls } = await setup(t, [row]);
    const result = await sync();
    assert.equal(result.details_fetched, expected);
    assert.equal(result.details_failed, 0);
    assert.equal(detailCalls().length, expected);
  });
}

test("newest first, account cap, new inserts before backfill, and free sanitized cache reads", async t => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`, [], { booking_date: `2030-01-0${i + 1}` }));
  // Include a repeated list row, and pre-insert the newest one to simulate an overlapping sync.
  const { db, sync, stored, detailCalls, mock, env } = await setup(t, [...rows, rows[3]]);
  const insert = db.insertTransactionsIgnore.bind(db);
  let raced = false;
  db.insertTransactionsIgnore = async (items, collected) => {
    if (!raced) { raced = true; await insert([items.find(r => r.entry_reference === "ref-id-4")]); }
    return insert(items, collected);
  };
  const first = await sync();
  assert.equal(first.new_transactions, 4);
  assert.equal(first.details_fetched, ENRICH_MAX_PER_ACCOUNT);
  assert.deepEqual(detailCalls().map(c => c.path.split("/").at(-1)), ["id-3", "id-2", "id-1"]);
  const row = stored().find(r => r.entry_reference === "ref-id-3");
  assert.equal(row.remittance_info, "Example payer");
  assert.equal(row.counterparty, "Payer name");
  assert.equal(row.dedup_key, "er:ref-id-3");
  assert.equal(row.entry_reference, "ref-id-3");
  assert.equal(row.amount_cents, 1234);
  assert.equal(row.booking_date, "2030-01-04");
  assert.equal(row.value_date, "2029-12-31");
  assert.deepEqual(JSON.parse(row.raw), { ...rows[3], detail });
  assert.ok(Number.isFinite(Date.parse(row.detail_fetched_at)));
  assert.deepEqual(await sync(), { account_uid: "account-0-0", new_transactions: 0, pending: 0, details_fetched: 2, details_failed: 0 });
  assert.deepEqual(detailCalls().map(c => c.path.split("/").at(-1)), ["id-3", "id-2", "id-1", "id-4", "id-0"]);
  const count = mock.calls.length;
  db.tryChargeRefreshBudget = () => { throw new Error("cache must not charge"); };
  env.DB.sqlite.exec("UPDATE eb_sessions SET status = 'expired'");
  for (let i = 0; i < 2; i++) {
    const result = await readTransactionDetails(db, () => { throw new Error("cache must not construct client"); },
      { booking_date: row.booking_date, amount: 12.34, transaction_id: "id-3" });
    assert.deepEqual(result, { ...sanitizeTransactionDetails(detail), list_row: sanitizeTransactionDetails(rows[3], row), cached_detail: true });
    assert.equal(JSON.stringify(result).includes("hidden-value"), false);
  }
  assert.equal(mock.calls.length, count);
});

for (const [name, text, party, expectedText, expectedParty, direction] of [
  ["empty detail", [], null, "Account Holder", null, "CRDT"],
  ["same text", ["Account Holder"], null, "Account Holder", null, "CRDT"],
  ["existing counterparty", ["New text"], "Existing", "New text", "Existing", "CRDT"],
  ["missing detail party", ["New text"], null, "New text", null, "CRDT"],
  ["debit creditor", ["New text"], null, "New text", "Payee name", "DBIT"],
]) {
  test(`detail adds information: ${name}`, async t => {
    const reply = { ...detail, remittance_information: text, debtor: name === "missing detail party" ? null : detail.debtor,
      creditor: { name: "Payee name" } };
    const { sync, stored } = await setup(t, [transaction("one", ["Account Holder"], {
      entry_reference: null, debtor: party ? { name: party } : null, credit_debit_indicator: direction,
    })], { reply });
    await sync();
    const [row] = stored();
    assert.match(row.dedup_key, /^h:/);
    assert.equal(row.entry_reference, null);
    assert.equal(row.remittance_info, expectedText);
    assert.equal(row.counterparty, expectedParty);
    assert.deepEqual(JSON.parse(row.raw).detail, reply);
    assert.ok(row.detail_fetched_at);
    const key = row.dedup_key;
    await sync();
    assert.equal(stored().length, 1);
    assert.equal(stored()[0].dedup_key, key);
  });
}

test("default session cap is shared across accounts and resets for each session/run", async t => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`));
  const { env, routes, detailCalls } = await setup(t, rows, { accounts: 3, sessions: 2 });
  const first = await syncAll(env, "cron");
  assert.equal(first.accounts_synced, 6);
  assert.equal(first.details_fetched, ENRICH_MAX_PER_SESSION * 2);
  assert.equal(first.details_failed, 0);
  assert.equal(detailCalls().length, 12);
  for (const [path, response] of Object.entries(routes)) {
    if (path.endsWith("/transactions")) {
      const next = transaction("next");
      response.transactions = [next];
      routes[`${path}/next`] = detail;
    }
  }
  assert.equal((await syncAll(env, "refresh")).details_fetched, ENRICH_MAX_PER_SESSION * 2);
});

for (const limit of [0, 1, 8]) {
  test(`enrichMax=${limit} overrides both per-account and per-session defaults`, async t => {
    const rows = Array.from({ length: 10 }, (_, i) => transaction(`id-${i}`));
    const { env, detailCalls } = await setup(t, rows, { accounts: 3 });
    const result = await syncAll(env, "cron", { enrichMax: limit });
    assert.equal(result.accounts_synced, 3);
    assert.equal(result.details_fetched, limit);
    assert.equal(detailCalls().length, limit);
  });
}

for (const [status, body, stopped] of [[429, "limited", "rate_limited"], [400, "EXPIRED_SESSION", "expired"], [503, "failed", null]]) {
  test(`detail HTTP ${status}: no retry, counts failure and ${stopped ? "stops session" : "uses cap and continues"}`, async t => {
    const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`));
    const { env, stored, mock, detailCalls } = await setup(t, rows, { accounts: 3, sessions: 2,
      reply: () => new Response(body, { status }) });
    const result = await syncAll(env, "cron");
    assert.equal(result.details_failed, stopped ? 2 : 12);
    assert.equal(result.details_fetched, 0);
    assert.equal(result.accounts_synced, stopped ? 2 : 6);
    assert.equal(detailCalls().length, result.details_failed);
    assert.ok(stored().every(r => !r.detail_fetched_at && !JSON.parse(r.raw).detail));
    if (stopped) {
      assert.equal(mock.calls.length, 6); // list + balance + one detail per session
      assert.equal(result.errors.length, 2);
      const sessions = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all();
      if (stopped === "expired") assert.ok(sessions.every(s => s.last_live_result === "expired_session"));
      assert.ok(sessions.every(s => stopped === "expired" ? s.status === "expired" : Date.parse(s.backoff_until) > Date.now()));
      assert.equal((await syncAll(env, "cron")).details_failed, 0);
      assert.equal(mock.calls.length, 6);
    }
  });
}

test("a failed candidate consumes a slot and the next candidate succeeds", async t => {
  const rows = Array.from({ length: 4 }, (_, i) => transaction(`id-${i}`));
  let requests = 0;
  const { sync, detailCalls } = await setup(t, rows, { reply: () => ++requests === 1 ? new Response("failed", { status: 503 }) : detail });
  const result = await sync();
  assert.equal(result.details_failed, 1);
  assert.equal(result.details_fetched, 2);
  assert.equal(detailCalls().length, 3);
});


test("authorization backfill also shares the session cap", async t => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`));
  const { env, db, detailCalls } = await setup(t, rows, { accounts: 3 });
  const results = await backfillAccounts(env, await db.allAccounts());
  assert.equal(results.reduce((n, r) => n + r.details_fetched, 0), ENRICH_MAX_PER_SESSION);
  assert.equal(detailCalls().length, ENRICH_MAX_PER_SESSION);
});

// Review regressions use real persisted rows and HTTP dispatches.
test("on-demand enrichment completing during sync balances makes exactly one detail HTTP call", async t => {
  const { env, db, routes, sync, detailCalls } = await setup(t, [transaction("one")]);
  routes["GET /accounts/account-0-0/balances"] = async () => {
    const result = await readTransactionDetails(db, () => new EbClient(env),
      { booking_date: "2030-01-01", amount: 12.34, transaction_id: "one" });
    assert.deepEqual(result.remittance_information, ["Example payer"]);
    return { balances: [] };
  };
  const result = await sync();
  assert.equal(result.new_transactions, 1);
  assert.equal(result.details_fetched, 0);
  assert.equal(result.details_failed, 0);
  assert.equal(detailCalls().length, 1);
});

for (const marker of ["timestamp", "raw.detail"]) {
  test(`sync rechecks persisted ${marker} before detail dispatch`, async t => {
    const { env, routes, sync, detailCalls } = await setup(t, [transaction("one")]);
    routes["GET /accounts/account-0-0/balances"] = () => {
      env.DB.sqlite.exec(marker === "timestamp"
        ? "UPDATE transactions SET detail_fetched_at = '2030-01-01'"
        : "UPDATE transactions SET raw = json_set(raw, '$.detail', json('{}'))");
      return { balances: [] };
    };
    assert.equal((await sync()).details_fetched, 0);
    assert.equal(detailCalls().length, 0);
  });
}

for (const raw of ["{invalid JSON", null, "null", '{"transaction_id":"one","remittance_information":42}']) {
  test(`invalid enrichment candidate is skipped: ${raw}`, async t => {
    const { db, sync, detailCalls } = await setup(t, [transaction("one")]);
    const insert = db.insertTransactionsIgnore.bind(db);
    db.insertTransactionsIgnore = (rows, collected) => insert(rows.map(row => ({ ...row, raw })), collected);
    const result = await sync();
    assert.equal(result.new_transactions, 1);
    assert.equal(result.details_fetched, 0);
    assert.equal(result.details_failed, 0);
    assert.equal(detailCalls().length, 0);
  });
}

for (const [status, body, method] of [[429, "limited", "setSessionBackoff"], [400, "EXPIRED_SESSION", "setSessionExpired"]]) {
  test(`detail HTTP ${status} metadata write failure preserves core results and stops the session`, async t => {
    const { env, stored, mock, detailCalls, routes } = await setup(t, [transaction("one")], {
      accounts: 2, reply: () => new Response(body, { status }),
    });
    routes["GET /accounts/account-0-0/balances"] = { balances: [{ balance_type: "CLBD",
      balance_amount: { amount: "42.00", currency: "EUR" } }] };
    const original = Db.prototype[method];
    let writes = 0;
    Db.prototype[method] = async () => { writes++; throw new Error("injected private metadata error"); };
    t.after(() => { Db.prototype[method] = original; });
    const result = await syncAll(env, "cron");
    assert.equal(writes, 1);
    assert.equal(result.accounts_synced, 1);
    assert.equal(result.new_transactions, 1);
    assert.equal(result.details_failed, 1);
    assert.equal(result.details_fetched, 0);
    assert.equal(detailCalls().length, 1);
    assert.equal(mock.calls.length, 3);
    assert.equal(stored().length, 1);
    assert.ok(env.DB.sqlite.prepare("SELECT last_synced_at FROM accounts WHERE account_uid = 'account-0-0'").get().last_synced_at);
    assert.equal(env.DB.sqlite.prepare("SELECT amount_cents FROM balances").get().amount_cents, 4200);
    assert.equal(result.errors.length, 2);
    // No IBAN on the fixture account, so the generic label; never the account uid.
    assert.equal(result.errors[0], "account: enrichment metadata write failed");
    assert.equal(result.errors.join(" ").includes("account-0-0"), false);
    assert.match(result.errors[1], status === 429 ? /rate-limited/ : /expired/);
    assert.equal(JSON.stringify(result).includes("injected private"), false);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const order of ["sync first", "tool first"]) {
  test(`atomic detail claim coordinates overlapping HTTP: ${order}`, { timeout: 5000 }, async t => {
    const enteredHttp = deferred();
    const finishHttp = deferred();
    t.after(() => finishHttp.resolve());
    const { env, db, routes, sync, stored, detailCalls } = await setup(t, [transaction("one")], {
      reply: async () => { enteredHttp.resolve(); await finishHttp.promise; return detail; },
    });
    // Count actual persisted detail updates independently of claim/release writes.
    env.DB.sqlite.exec(`CREATE TABLE detail_writes (id INTEGER);
      CREATE TRIGGER count_detail_writes AFTER UPDATE OF detail_fetched_at ON transactions
      WHEN OLD.detail_fetched_at IS NULL AND NEW.detail_fetched_at IS NOT NULL
      BEGIN INSERT INTO detail_writes VALUES (NEW.id); END;`);
    const toolDb = new Db(env);
    const lostClaim = deferred();
    const claim = toolDb.claimTransactionDetail.bind(toolDb);
    toolDb.claimTransactionDetail = async (...args) => {
      const won = await claim(...args);
      if (!won) lostClaim.resolve();
      return won;
    };
    const read = () => readTransactionDetails(toolDb, () => new EbClient(env),
      { booking_date: "2030-01-01", amount: 12.34, transaction_id: "one" });
    let toolRun;
    if (order === "tool first") {
      // Pause sync after its insert, before enrichment, so the tool owns HTTP.
      routes["GET /accounts/account-0-0/balances"] = async () => {
        toolRun = read();
        await enteredHttp.promise;
        return { balances: [] };
      };
    }
    const syncRun = sync();
    await enteredHttp.promise;
    if (order === "sync first") {
      toolRun = read();
      await lostClaim.promise;
    } else {
      assert.equal((await syncRun).details_fetched, 0);
    }
    assert.equal(detailCalls().length, 1);
    assert.equal(stored()[0].detail_fetched_at, null);
    finishHttp.resolve();
    const [syncResult, toolResult] = await Promise.all([syncRun, toolRun]);
    assert.equal(syncResult.details_fetched, order === "sync first" ? 1 : 0);
    assert.equal(syncResult.details_failed, 0);
    assert.equal(toolResult.cached_detail, order === "sync first" ? true : undefined);
    assert.deepEqual(toolResult.remittance_information, detail.remittance_information);
    assert.equal(detailCalls().length, 1);
    assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM detail_writes").get().n, 1);
    assert.deepEqual(JSON.parse(stored()[0].raw).detail, detail);
    assert.equal(stored()[0].detail_claimed_at, null);
    assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today AS n FROM eb_sessions").get().n,
      order === "sync first" ? 0 : 1);
  });
}

for (const stale of [false, true]) {
  test(`claim contention preserves account and session cap; stale=${stale}`, async t => {
    const { env, db, routes, sync, stored, detailCalls } = await setup(t, [
      transaction("newest", [], { booking_date: "2030-01-02" }), transaction("next"),
    ]);
    routes["GET /accounts/account-0-0/balances"] = async () => {
      const row = stored()[0];
      const now = Date.now();
      const at = new Date(now - (stale ? 121_000 : 0)).toISOString();
      assert.equal(await new Db(env).claimTransactionDetail(row.id, at, new Date(now - 240_000).toISOString()), true);
      return { balances: [] };
    };
    const budget = { remaining: 1 };
    const result = await sync({ enrichMax: 1, enrichmentBudget: budget });
    assert.equal(result.details_fetched, 1);
    assert.equal(result.details_failed, 0);
    assert.equal(budget.remaining, 0);
    assert.deepEqual(detailCalls().map(c => c.path.split("/").at(-1)), [stale ? "newest" : "next"]);
  });
}

test("failed sync HTTP releases the claim for a later tool retry", async t => {
  const { env, routes, sync, stored, detailCalls } = await setup(t, [transaction("one")], {
    reply: () => new Response("unavailable", { status: 503 }),
  });
  assert.equal((await sync()).details_failed, 1);
  assert.equal(stored()[0].detail_claimed_at, null);
  assert.equal(stored()[0].detail_fetched_at, null);
  routes["GET /accounts/account-0-0/transactions/one"] = detail;
  const result = await readTransactionDetails(new Db(env), () => new EbClient(env),
    { booking_date: "2030-01-01", amount: 12.34, transaction_id: "one" });
  assert.deepEqual(result.remittance_information, detail.remittance_information);
  assert.equal(detailCalls().length, 2);
  assert.ok(stored()[0].detail_fetched_at);
});

// Existing cache rows must not depend on being returned in the next bank list.
async function seedBackfill(t, rows, options) {
  const fixture = await setup(t, rows, options);
  await syncAll(fixture.env, "seed", { enrichMax: 0 });
  for (const [path, response] of Object.entries(fixture.routes)) {
    if (path.endsWith("/transactions")) response.transactions = [];
  }
  return fixture;
}

test("cron default path enriches existing eligible rows through the inclusive 45-day boundary", async t => {
  assert.equal(ENRICH_BACKFILL_DAYS, 45);
  const { env, stored, detailCalls } = await seedBackfill(t, [
    transaction("outside", [], { booking_date: daysAgo(46) }),
    transaction("boundary", ["123 456"], { booking_date: daysAgo(45) }),
    transaction("recent", ["  ACCOUNT", " HOLDER "], { booking_date: daysAgo(1) }),
    transaction("empty", [], { booking_date: daysAgo(2) }),
  ]);
  const result = await syncAll(env, "cron");
  assert.equal(result.new_transactions, 0);
  assert.equal(result.details_fetched, 3);
  assert.equal(result.details_failed, 0);
  assert.deepEqual(detailCalls().map(c => c.path.split("/").at(-1)), ["recent", "empty", "boundary"]);
  assert.equal(stored().find(r => r.entry_reference === "ref-outside").detail_fetched_at, null);
  assert.equal((await syncAll(env, "cron")).details_fetched, 0);
  assert.equal(detailCalls().length, 3);
});

for (const entry of ["account", "all"]) {
  test(`enrichBackfillDays override and zero disable only backfill via ${entry}`, async t => {
    const { env, sync, routes, detailCalls } = await seedBackfill(t, [
      transaction("boundary", [], { booking_date: daysAgo(2) }),
      transaction("older", [], { booking_date: daysAgo(3) }),
    ]);
    const run = opts => entry === "account" ? sync(opts) : syncAll(env, "cron", opts);
    const path = "GET /accounts/account-0-0/transactions";
    routes[path].transactions = [transaction("new", [], { booking_date: daysAgo(60) })];
    routes[`${path}/new`] = detail;
    assert.equal((await run({ enrichBackfillDays: 0 })).details_fetched, 1);
    assert.equal((await run({ enrichBackfillDays: 2, enrichMax: 0 })).details_fetched, 0);
    assert.equal((await run({ enrichBackfillDays: 2 })).details_fetched, 1);
    assert.deepEqual(detailCalls().map(c => c.path.split("/").at(-1)), ["new", "boundary"]);
  });
}

for (const limit of [undefined, 1, 8]) {
  test(`new and backfill share account/session caps, enrichMax=${limit}`, async t => {
    const { env, routes, detailCalls } = await seedBackfill(t,
      Array.from({ length: 10 }, (_, i) => transaction(`cached-${i}`, [], { booking_date: daysAgo(i) })),
      { accounts: 3 });
    for (const [path, response] of Object.entries(routes)) {
      if (path.endsWith("/transactions")) {
        response.transactions = [transaction("new", [], { booking_date: daysAgo(60) })];
        routes[`${path}/new`] = detail;
      }
    }
    const result = await syncAll(env, "cron", { enrichMax: limit });
    const sessionCap = limit ?? ENRICH_MAX_PER_SESSION;
    const accountCap = limit ?? ENRICH_MAX_PER_ACCOUNT;
    assert.equal(result.new_transactions, 3);
    assert.equal(result.details_fetched, sessionCap);
    assert.equal(detailCalls().length, sessionCap);
    for (let a = 0; a < 3; a++) {
      const calls = detailCalls().filter(c => c.path.startsWith(`/accounts/account-0-${a}/`));
      assert.ok(calls.length <= accountCap);
      if (calls.length) {
        assert.equal(calls[0].path.split("/").at(-1), "new");
        assert.deepEqual(calls.slice(1).map(c => c.path.split("/").at(-1)),
          Array.from({ length: calls.length - 1 }, (_, i) => `cached-${i}`));
      }
    }
  });
}

test("failed new candidates are deduplicated by id before backfill dispatch", async t => {
  const { sync, detailCalls } = await setup(t, [transaction("one", [], { booking_date: daysAgo(0) })], {
    reply: () => new Response("unavailable", { status: 503 }),
  });
  const result = await sync();
  assert.equal(result.details_failed, 1);
  assert.equal(result.details_fetched, 0);
  assert.equal(detailCalls().length, 1);
});

test("backfill skips enriched, claimed, malformed and ineligible rows and stays within its account", async t => {
  const ids = ["timestamp", "detail", "claimed", "invalid", "null", "malformed", "merchant", "no-id", "eligible"];
  const { env, db, sync, stored, detailCalls } = await seedBackfill(t,
    ids.map(id => transaction(id, [], { booking_date: daysAgo(id === "eligible" ? 2 : 1) })),
    { accounts: 2 });
  const update = env.DB.sqlite.prepare("UPDATE transactions SET raw = ? WHERE entry_reference = ?");
  env.DB.sqlite.exec("UPDATE transactions SET detail_fetched_at = '2030-01-01' WHERE entry_reference = 'ref-timestamp'");
  for (const [id, raw] of [
    ["detail", JSON.stringify({ ...transaction("detail", []), detail: {} })],
    ["invalid", "{invalid JSON"], ["null", null],
    ["malformed", JSON.stringify(transaction("malformed", 42))],
    ["merchant", JSON.stringify(transaction("merchant", ["Example shop"]))],
    ["no-id", JSON.stringify(transaction(null, []))],
  ]) update.run(raw, `ref-${id}`);
  const claimed = stored().find(r => r.account_uid === "account-0-0" && r.entry_reference === "ref-claimed");
  assert.equal(await db.claimTransactionDetail(claimed.id, new Date().toISOString(), daysAgo(1)), true);
  const result = await sync({ enrichMax: 1 });
  assert.equal(result.details_fetched, 1);
  assert.equal(result.details_failed, 0);
  assert.deepEqual(detailCalls().map(c => c.path), ["/accounts/account-0-0/transactions/eligible"]);
  assert.equal(stored().find(r => r.account_uid === "account-0-1" && r.entry_reference === "ref-eligible").detail_fetched_at, null);
});

// --- enrichmentPolicyFromEnv: nightly cron config from optional, non-secret Worker vars ---

test("enrichmentPolicyFromEnv falls back to the built-in recommendations when vars are missing", () => {
  assert.deepEqual(enrichmentPolicyFromEnv({}), {
    enrichBackfillDays: ENRICH_BACKFILL_DAYS,
    enrichMaxPerAccount: ENRICH_MAX_PER_ACCOUNT,
    enrichMaxPerSession: ENRICH_MAX_PER_SESSION,
  });
});

for (const bad of ["-1", "abc", "1.5abc", "", "NaN", "-0.5"]) {
  test(`enrichmentPolicyFromEnv falls back on invalid var: "${bad}"`, () => {
    const policy = enrichmentPolicyFromEnv({
      ENRICH_BACKFILL_DAYS: bad, ENRICH_MAX_PER_ACCOUNT: bad, ENRICH_MAX_PER_SESSION: bad,
    });
    assert.deepEqual(policy, {
      enrichBackfillDays: ENRICH_BACKFILL_DAYS,
      enrichMaxPerAccount: ENRICH_MAX_PER_ACCOUNT,
      enrichMaxPerSession: ENRICH_MAX_PER_SESSION,
    });
  });
}

test("enrichmentPolicyFromEnv parses valid non-negative integers, including 0", () => {
  assert.deepEqual(
    enrichmentPolicyFromEnv({ ENRICH_BACKFILL_DAYS: "0", ENRICH_MAX_PER_ACCOUNT: "7", ENRICH_MAX_PER_SESSION: "14" }),
    { enrichBackfillDays: 0, enrichMaxPerAccount: 7, enrichMaxPerSession: 14 }
  );
});

test("cron threads the env policy's separate per-account and per-session caps", async t => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`));
  const { env, detailCalls } = await setup(t, rows, { accounts: 3 });
  const result = await syncAll(env, "cron", { enrichMaxPerAccount: 1, enrichMaxPerSession: 2, enrichBackfillDays: 45 });
  assert.equal(result.details_fetched, 2);
  assert.equal(detailCalls().length, 2);
  for (let a = 0; a < 3; a++) {
    assert.ok(detailCalls().filter(c => c.path.startsWith(`/accounts/account-0-${a}/`)).length <= 1);
  }
});

test("enrichMax still overrides enrichMaxPerAccount/enrichMaxPerSession when both are given", async t => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`));
  const { env, detailCalls } = await setup(t, rows, { accounts: 1 });
  const result = await syncAll(env, "cron", { enrichMax: 4, enrichMaxPerAccount: 1, enrichMaxPerSession: 1 });
  assert.equal(result.details_fetched, 4);
  assert.equal(detailCalls().length, 4);
});

// --- previewEnrichmentCandidates: cache-only dry-run preview backing refresh_now's enrichment_dry_run ---

test("previewEnrichmentCandidates makes no HTTP calls and performs no writes", async t => {
  const rows = Array.from({ length: 3 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { env, db, mock, stored } = await seedBackfill(t, rows);
  const before = stored();
  const callsBefore = mock.calls.length;
  const result = await previewEnrichmentCandidates(db, await db.allAccounts());
  assert.equal(mock.calls.length, callsBefore);
  assert.deepEqual(stored(), before);
  assert.equal(result.total_candidates, 3);
  assert.deepEqual(result.accounts, [{ account: "  Account   Holder  ", candidates: 3 }]);
});

test("previewEnrichmentCandidates respects enrichBackfillDays and enrichMax", async t => {
  const rows = [
    transaction("outside", [], { booking_date: daysAgo(46) }),
    transaction("boundary", [], { booking_date: daysAgo(45) }),
    transaction("recent", [], { booking_date: daysAgo(1) }),
  ];
  const { db } = await seedBackfill(t, rows);
  const accounts = await db.allAccounts();
  const withDefaults = await previewEnrichmentCandidates(db, accounts);
  assert.equal(withDefaults.total_candidates, 2); // boundary + recent, outside is past the 45-day window
  const capped = await previewEnrichmentCandidates(db, accounts, { enrichMax: 1 });
  assert.equal(capped.total_candidates, 1);
  const disabledBackfill = await previewEnrichmentCandidates(db, accounts, { enrichBackfillDays: 0 });
  assert.equal(disabledBackfill.total_candidates, 0);
  const disabledMax = await previewEnrichmentCandidates(db, accounts, { enrichMax: 0 });
  assert.equal(disabledMax.total_candidates, 0);
});

test("previewEnrichmentCandidates scopes to the accounts passed in and shares the session budget across them", async t => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { db } = await seedBackfill(t, rows, { accounts: 3 });
  const accounts = await db.allAccounts();
  const oneAccount = await previewEnrichmentCandidates(db, accounts.filter(a => a.account_uid === "account-0-0"), { enrichMax: 2 });
  assert.equal(oneAccount.accounts.length, 1);
  assert.equal(oneAccount.total_candidates, 2);
  const allThree = await previewEnrichmentCandidates(db, accounts, { enrichMax: 2 });
  assert.equal(allThree.accounts.length, 3);
  assert.equal(allThree.total_candidates, 2); // shared per-session budget, not 2 per account
});

test("previewEnrichmentCandidates output is sanitized: no raw JSON, transaction ids, or account uids", async t => {
  const rows = [transaction("secret-id", ["Account Holder"], { booking_date: daysAgo(1) })];
  const { db } = await seedBackfill(t, rows);
  const result = await previewEnrichmentCandidates(db, await db.allAccounts());
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-id"), false);
  assert.equal(serialized.includes("account-0-0"), false);
  assert.deepEqual(Object.keys(result).sort(), ["accounts", "total_candidates"]);
  assert.deepEqual(Object.keys(result.accounts[0]).sort(), ["account", "candidates"]);
});
