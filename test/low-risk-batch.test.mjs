// Coverage for the low-risk batch: terminal session codes, longest-first
// backfill, account metadata, the bank-list cache, spending aggregation,
// response trimming and the work-time reframe. Zero bank calls beyond mocks.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createD1, createEnv, mockEnableBanking } from "./helpers.mjs";

const { EbClient, ExpiredSessionError } = await import("../src/eb.ts");
const { Db } = await import("../src/db.ts");
const { migrate } = await import("../src/migrate.ts");
const { syncAll, backfillAccounts, BACKFILL_LADDER } = await import("../src/sync.ts");
const { accountMetadata } = await import("../src/auth.ts");
const { aspspRows, refreshAspspCache, ASPSP_CACHE_TTL_MS } = await import("../src/aspsps.ts");
const { compactJson, serializeMcpText, AUTH_LINK_CMD } = await import("../src/mcp-output.ts");

const session = { id: "local", session_id: "upstream", psu_type: "personal", aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2099-01-01T00:00:00Z" };
const account = { account_uid: "account", session_pk: "local", name: "Primary", iban: "SE1234567890", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null };

async function setup(t, routes = {}) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  const db = new Db(env);
  await db.insertSession(session);
  await db.upsertAccounts([account]);
  return { env, mock, db };
}

/** Same slicing as omitted-params.test.mjs: run one real handler body against a Db. */
function handler(name, dependencies) {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf("      async (", source.indexOf(`      "${name}",`));
  const end = source.indexOf("\n    );", start);
  const body = source.slice(start, end).trim()
    .replace("new Map<string, { currency: string; out: number; in: number; count: number }>()", "new Map()")
    .replace(/^async \(([^)]*)\) =>/, "async function($1)");
  const money = source.slice(source.indexOf("function money("), source.indexOf("function signed("));
  return Function(...Object.keys(dependencies), `${stripTypeScriptTypes(money)}; return ${stripTypeScriptTypes(`(${body})`)};`)(...Object.values(dependencies));
}

function self(db, uids = null) {
  return { db: () => db, resolveAccountUids: async () => uids, warnings: async () => "", text: serializeMcpText };
}
const deps = { compactJson, AUTH_LINK_CMD };
const { annotateTransactions, categoryFields } = await import("../src/categories.ts");
const parse = (r) => JSON.parse(r.content[0].text);

// ---- 5.1 terminal session codes ----

for (const code of ["REVOKED_SESSION", "CLOSED_SESSION", "SESSION_DOES_NOT_EXIST", "WRONG_SESSION_STATUS", "EXPIRED_SESSION"]) {
  test(`${code} from the bank marks the session expired and stops the sync`, async (t) => {
    const { env, mock, db } = await setup(t, {
      "GET /accounts/account/transactions": () => new Response(JSON.stringify({ error: { code } }), { status: 401 }),
    });
    const result = await syncAll(env, "test");
    assert.deepEqual(result.errors, ["session personal: expired; reauthorization required"]);
    assert.equal((await db.sessionsForVerification("local"))[0].status, "expired");
    assert.equal(mock.calls.length, 1);
    await assert.rejects(new EbClient(env).getTransactions("account"), (e) => e instanceof ExpiredSessionError && e.code === code);
  });
}

// ---- 5.3 strategy=longest first in backfill ----

test("backfill asks for strategy=longest first and falls back to plain windows", async (t) => {
  assert.deepEqual(BACKFILL_LADDER[0], { days: 1825, strategy: "longest" });
  assert.equal(BACKFILL_LADDER.at(-1).days, 92);
  const { env, mock } = await setup(t, {
    "GET /accounts/account/transactions": (url) =>
      url.searchParams.get("strategy") === "longest"
        ? new Response("no", { status: 400 })
        : { transactions: [{ entry_reference: "a", booking_date: "2030-01-01", transaction_amount: { amount: "1.00", currency: "SEK" }, credit_debit_indicator: "DBIT" }] },
    "GET /accounts/account/balances": { balances: [] },
  });
  const results = await backfillAccounts(env, [account]);
  assert.equal(results[0].new_transactions, 1);
  const pages = mock.calls.filter((c) => c.path.endsWith("/transactions"));
  assert.equal(pages[0].search.get("strategy"), "longest");
  assert.equal(pages[1].search.get("strategy"), null);
  assert.equal(pages.length, 2);
});

// ---- 5.5 account metadata ----

test("account metadata keeps only the last four card digits and survives upsert", async (t) => {
  const meta = accountMetadata({
    uid: "x", cash_account_type: "CARD", usage: "PRIV", credit_limit: { currency: "SEK", amount: "15000.50" },
    account_servicer: { bic_fi: "ESSESESS" },
    all_account_ids: [{ identification: "4571 1234 5678 9012", scheme_name: "CPAN" }],
  });
  assert.deepEqual(meta, { cash_account_type: "CARD", credit_limit_cents: 1500050, usage: "PRIV", bic: "ESSESESS", card_last4: "9012" });
  assert.deepEqual(accountMetadata({ uid: "y" }), { cash_account_type: null, credit_limit_cents: null, usage: null, bic: null, card_last4: null });
  const { db } = await setup(t);
  await db.upsertAccounts([{ ...account, ...meta }]);
  const row = (await db.allAccounts())[0];
  assert.equal(row.card_last4, "9012");
  assert.equal(row.credit_limit_cents, 1500050);
  assert.equal(JSON.stringify(row).includes("4571"), false);
});

test("list_accounts exposes metadata masked and drops unset fields", async (t) => {
  const { db } = await setup(t);
  await db.upsertAccounts([{ ...account, cash_account_type: "CACC", credit_limit_cents: 100000 }]);
  const out = parse(await handler("list_accounts", { ...deps, maskIban: (i) => (i ? `•••• ${i.slice(-4)}` : null) }).call(self(db)));
  assert.equal(out[0].account_type, "CACC");
  assert.equal(out[0].credit_limit, 1000);
  assert.equal("card_last4" in out[0], false);
  assert.equal("bic" in out[0], false);
  assert.equal(out[0].iban, "•••• 7890");
});

test("account metadata migration is additive and idempotent on the pre-feature schema", async (t) => {
  const DB = createD1();
  t.after(() => DB.close());
  // SQLite refuses DROP COLUMN on some shapes; build the legacy schema from git instead.
  const legacy = execFileSync("git", ["show", "HEAD:schema.sql"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  DB.sqlite.exec(legacy);
  DB.sqlite.exec("INSERT INTO eb_sessions (id, session_id, psu_type) VALUES ('s', 'u', 'personal')");
  DB.sqlite.exec("INSERT INTO accounts (account_uid, session_pk, psu_type, iban) VALUES ('a', 's', 'personal', 'SE1')");
  await migrate(DB);
  await migrate(DB);
  const row = DB.sqlite.prepare("SELECT * FROM accounts").get();
  assert.equal(row.iban, "SE1");
  assert.equal(row.card_last4, null);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM aspsp_cache").get().n, 0);
});

// ---- 5.7 list_banks ----

test("bank list cache refreshes only past the TTL and list_banks reads the cache", async (t) => {
  const { db } = await setup(t);
  let calls = 0;
  const fetcher = async () => { calls++; return [
    { name: "Nordea", country: "se", psu_types: ["personal", "business"], maximum_consent_validity: 180 * 86400 },
    { name: "Nordea", country: "FI", psu_types: ["personal"] },
    { name: "SEB", country: "SE" },
  ]; };
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(await refreshAspspCache(db, fetcher, now), true);
  assert.equal(await refreshAspspCache(db, fetcher, now + ASPSP_CACHE_TTL_MS - 1), false);
  assert.equal(await refreshAspspCache(db, fetcher, now + ASPSP_CACHE_TTL_MS), true);
  assert.equal(calls, 2);
  const out = parse(await handler("list_banks", deps).call(self(db), { country: "se", search: "nord", limit: 100 }));
  assert.deepEqual(out.banks, [{ name: "Nordea", country: "SE", psu_types: ["personal", "business"], max_consent_days: 180 }]);
  assert.equal(out.cached_at, new Date(now + ASPSP_CACHE_TTL_MS).toISOString());
  const all = parse(await handler("list_banks", deps).call(self(db), { limit: 2 }));
  assert.equal(all.banks.length, 2);
  assert.match(all.note, /first 2 banks/);
});

test("list_banks on an empty cache explains how it fills and a failing refresh is swallowed", async (t) => {
  const { db } = await setup(t);
  assert.equal(await refreshAspspCache(db, async () => { throw new Error("down"); }), false);
  const out = parse(await handler("list_banks", deps).call(self(db), { limit: 100 }));
  assert.equal("banks" in out, false);
  assert.match(out.note, /not cached yet/);
  assert.equal(aspspRows([{ name: 1, country: "SE" }]).length, 0);
});

// ---- 6.1 spending_summary ----

async function seedTransactions(db) {
  const tx = (i, booking_date, amount_cents, credit_debit, counterparty, currency = "SEK") => ({
    account_uid: "account", booking_date, value_date: null, amount_cents, currency, credit_debit,
    counterparty, remittance_info: null, entry_reference: `e${i}`, dedup_key: `e${i}`, raw: "{}",
  });
  await db.insertTransactionsIgnore([
    tx(1, "2030-01-05", 10000, "DBIT", "ICA"),
    tx(2, "2030-01-20", 5000, "DBIT", "ICA"),
    tx(3, "2030-01-25", 30000, "CRDT", "Employer"),
    tx(4, "2030-02-02", 2000, "DBIT", "Spotify"),
    tx(5, "2030-02-03", 1000, "DBIT", "Cafe", "EUR"),
  ]);
}

test("spending_summary sums in the database per month and per counterparty", async (t) => {
  const { db, mock } = await setup(t);
  await seedTransactions(db);
  const byMonth = parse(await handler("spending_summary", deps).call(self(db), { group_by: "month", limit: 24 }));
  assert.deepEqual(byMonth.totals, [
    { currency: "SEK", out: 170, in: 300, net: 130, count: 4 },
    { currency: "EUR", out: 10, in: 0, net: -10, count: 1 },
  ]);
  assert.deepEqual(byMonth.groups[0], { month: "2030-02", currency: "EUR", out: 10, in: 0, net: -10, count: 1 });
  assert.deepEqual(byMonth.groups[1], { month: "2030-02", currency: "SEK", out: 20, in: 0, net: -20, count: 1 });
  assert.deepEqual(byMonth.groups[2], { month: "2030-01", currency: "SEK", out: 150, in: 300, net: 150, count: 3 });
  const byPayee = parse(await handler("spending_summary", deps).call(self(db), { group_by: "counterparty", date_to: "2030-01-31", limit: 1 }));
  assert.deepEqual(byPayee.groups, [{ counterparty: "ICA", currency: "SEK", out: 150, in: 0, net: -150, count: 2 }]);
  assert.match(byPayee.note, /first 1 groups/);
  assert.equal(mock.calls.length, 0);
});

// ---- 6.6 response trimming ----

test("compactJson drops null, empty and undefined but keeps zero and false; get_transactions opts in", async (t) => {
  assert.deepEqual(compactJson({ a: null, b: "", c: [], d: {}, e: 0, f: false, g: [null, { h: null, i: 1 }], j: undefined }),
    { e: 0, f: false, g: [{ i: 1 }] });
  const { db } = await setup(t);
  await seedTransactions(db);
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const signed = Function(`${stripTypeScriptTypes(source.slice(source.indexOf("function money("), source.indexOf("export class BankingMCP")))}; return signed;`)();
  const run = async (input) => parse(await handler("get_transactions", { ...deps, signed, annotateTransactions, categoryFields }).call(self(db), { limit: 100, include_pending: true, ...input }));
  const full = await run({});
  const compact = await run({ compact: true });
  assert.equal("description" in full.booked[0], true);
  assert.equal(full.booked[0].description, null);
  assert.equal("description" in compact.booked[0], false);
  assert.equal("pending" in compact, false);
  assert.equal(compact.booked.length, full.booked.length);
});

// ---- 6.8 amount_as_work_time ----

test("amount_as_work_time uses explicit income or estimates from cached inflows", async (t) => {
  const { db } = await setup(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-03-01T12:00:00Z") });
  await seedTransactions(db);
  const explicit = parse(await handler("amount_as_work_time", deps).call(self(db), { amount: 1600, monthly_net_income: 32000, hours_per_month: 160, months: 3 }));
  assert.equal(explicit.hours, 8);
  assert.equal(explicit.work_days, 1);
  assert.equal(explicit.basis, "explicit monthly_net_income");
  const estimated = parse(await handler("amount_as_work_time", deps).call(self(db), { amount: 300, hours_per_month: 160, months: 3 }));
  assert.equal(estimated.currency, "SEK");
  assert.equal(estimated.monthly_net_income, 100);
  assert.equal(estimated.hours, 480);
  assert.match(estimated.basis, /1 credits/);
  const none = parse(await handler("amount_as_work_time", deps).call(self(db), { amount: 1, currency: "USD", hours_per_month: 160, months: 3 }));
  assert.match(none.error, /No cached inflows/);
});
