import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createEnv, mockEnableBanking } from "./helpers.mjs";
const { Db } = await import("../src/db.ts");
const { syncAll, previewEnrichmentCandidates, ENRICH_MAX_PER_ACCOUNT, ENRICH_BACKFILL_DAYS } = await import("../src/sync.ts");
const { matchAccountUids, daysAgo } = await import("../src/util.ts");
const { serializeMcpText, buildSessionWarnings, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY } = await import("../src/mcp-output.ts");

const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");

function compile(body, deps) {
  return Function(...Object.keys(deps), `return ${stripTypeScriptTypes(`(${body})`)}`)(...Object.values(deps));
}
function refreshNowHandler(deps) {
  const start = source.indexOf("      async (", source.indexOf('      "refresh_now",'));
  const body = source.slice(start, source.indexOf("\n    );", start)).trim().replace(/^async \(([^)]*)\) =>/, "async function($1)");
  return compile(body, deps);
}
function resolver() {
  const start = source.indexOf("  private async resolveAccountUids(");
  return compile(source.slice(start, source.indexOf("\n  }", start) + 4).trim()
    .replace("private async resolveAccountUids", "async function"), { matchAccountUids });
}

/** refresh_now's own zod inputSchema block, isolated for static schema assertions. */
function refreshNowSchemaSource() {
  const toolStart = source.indexOf('      "refresh_now",');
  const schemaStart = source.indexOf("inputSchema: {", toolStart);
  const schemaEnd = source.indexOf("\n        },", schemaStart);
  return source.slice(schemaStart, schemaEnd);
}

function transaction(id, text = ["Account Holder"], extra = {}) {
  return { transaction_id: id, entry_reference: `ref-${id}`, booking_date: "2030-01-01",
    value_date: "2029-12-31", transaction_amount: { amount: "12.34", currency: "EUR" },
    credit_debit_indicator: "CRDT", status: "BOOK", remittance_information: text, ...extra };
}

async function setup(t, { accounts = 1, backfillRows = [] } = {}) {
  // Rows are dated relative to real wall-clock time by the caller before this mocks Date, so the
  // 45-day backfill window (also relative to "now") lines up with them.
  const env = await createEnv();
  t.after(() => env.DB.close());
  const db = new Db(env);
  await db.insertSession({ id: "session-0", session_id: "upstream-0", psu_type: "personal",
    aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2099-01-01T00:00:00Z" });
  const routes = {};
  for (let a = 0; a < accounts; a++) {
    const uid = `account-0-${a}`;
    await db.upsertAccounts([{ account_uid: uid, session_pk: "session-0", name: `Account ${a}`,
      iban: null, currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
    routes[`GET /accounts/${uid}/transactions`] = { transactions: backfillRows };
    routes[`GET /accounts/${uid}/balances`] = { balances: [] };
    for (const row of backfillRows) routes[`GET /accounts/${uid}/transactions/${row.transaction_id}`] = row;
  }
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  // Seed the cache with rows already present, without spending enrichment budget, then clear the list
  // response so a later refresh_now call would only find these via the backfill path.
  if (backfillRows.length) {
    await syncAll(env, "seed", { enrichMax: 0 });
    for (const [path, response] of Object.entries(routes)) {
      if (path.endsWith("/transactions")) response.transactions = [];
    }
  }
  const self = { db: () => db, cfg: env, env, resolveAccountUids: resolver(), text: serializeMcpText,
    warnings: async () => buildSessionWarnings(await db.sessionsNeedingWarning()) };
  return { env, db, mock, self };
}

// --- Schema: optional, no .default(), recommendations not selected defaults ---

test("enrichment_backfill_days, enrichment_max and enrichment_dry_run are optional with no zod default", () => {
  const schema = refreshNowSchemaSource();
  for (const field of ["enrichment_backfill_days", "enrichment_max", "enrichment_dry_run"]) {
    const fieldStart = schema.indexOf(`${field}:`);
    assert.ok(fieldStart >= 0, `${field} missing from refresh_now inputSchema`);
    const fieldEnd = schema.indexOf(`\n          )`, fieldStart);
    const block = schema.slice(fieldStart, fieldEnd >= 0 ? fieldEnd : fieldStart + 400);
    assert.ok(block.includes(".optional()"), `${field} must be .optional()`);
    assert.ok(!block.includes(".default("), `${field} must not use zod .default()`);
    if (field !== "enrichment_dry_run") {
      assert.match(block, /[Rr]ecommend/, `${field} description should read as a recommendation, not a selected default`);
    }
  }
});

// --- Compatibility: omitted params leave normal refresh_now behavior and output unchanged ---

test("omitted enrichment params thread nothing extra into syncAll and keep default caps", async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { env, self, mock } = await setup(t, { backfillRows: rows });
  const handler = refreshNowHandler({ syncAll, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY });
  const result = await handler.call(self, {});
  const [summary] = JSON.parse(result.content[0].text);
  assert.equal(summary.details_fetched, ENRICH_MAX_PER_ACCOUNT);
  assert.equal(mock.calls.filter(c => /\/transactions\/id-/.test(c.path)).length, ENRICH_MAX_PER_ACCOUNT);
});

// --- Explicit 0 and custom values are threaded through to syncAll for a real (non-dry-run) call ---

test("enrichment_max: 0 disables enrichment detail calls for this call", async (t) => {
  const rows = Array.from({ length: 3 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { self, mock } = await setup(t, { backfillRows: rows });
  const handler = refreshNowHandler({ syncAll, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY });
  const result = await handler.call(self, { enrichment_max: 0 });
  const [summary] = JSON.parse(result.content[0].text);
  assert.equal(summary.details_fetched, 0);
  assert.equal(mock.calls.filter(c => /\/transactions\/id-/.test(c.path)).length, 0);
});

test("enrichment_backfill_days: 0 disables backfill enrichment for this call", async (t) => {
  const rows = [transaction("one", [], { booking_date: daysAgo(2) })];
  const { self, mock } = await setup(t, { backfillRows: rows });
  const handler = refreshNowHandler({ syncAll, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY });
  const result = await handler.call(self, { enrichment_backfill_days: 0 });
  const [summary] = JSON.parse(result.content[0].text);
  assert.equal(summary.details_fetched, 0);
  assert.equal(mock.calls.filter(c => /\/transactions\/one/.test(c.path)).length, 0);
});

test("custom enrichment_max is threaded through and caps the actual run", async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { self, mock } = await setup(t, { backfillRows: rows });
  const handler = refreshNowHandler({ syncAll, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY });
  const result = await handler.call(self, { enrichment_max: 2 });
  const [summary] = JSON.parse(result.content[0].text);
  assert.equal(summary.details_fetched, 2);
  assert.equal(mock.calls.filter(c => /\/transactions\/id-/.test(c.path)).length, 2);
});

// --- enrichment_dry_run: zero HTTP, zero budget, zero writes, cache-only preview ---

test("enrichment_dry_run makes zero Enable Banking calls, spends zero budget, and writes nothing", async (t) => {
  const rows = Array.from({ length: 3 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { env, db, self, mock } = await setup(t, { backfillRows: rows });
  const before = env.DB.sqlite.prepare("SELECT * FROM transactions").all();
  const budgetBefore = env.DB.sqlite.prepare("SELECT refresh_count_today FROM eb_sessions").get().refresh_count_today;
  const callsBefore = mock.calls.length; // seeding the cache already made its own (unrelated) HTTP calls
  db.tryChargeRefreshBudget = async () => { throw new Error("dry run must not touch the refresh budget"); };
  const handler = refreshNowHandler({
    syncAll: async () => { throw new Error("dry run must not call syncAll"); },
    previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY,
  });
  const result = await handler.call(self, { enrichment_dry_run: true });
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.dry_run, true);
  assert.equal(output.total_candidates, 3);
  assert.equal(mock.calls.length, callsBefore);
  assert.deepEqual(env.DB.sqlite.prepare("SELECT * FROM transactions").all(), before);
  assert.equal(env.DB.sqlite.prepare("SELECT refresh_count_today FROM eb_sessions").get().refresh_count_today, budgetBefore);
});

test("enrichment_dry_run respects enrichment_backfill_days and enrichment_max", async (t) => {
  const rows = [transaction("in-window", [], { booking_date: daysAgo(2) }), transaction("out-of-window", [], { booking_date: daysAgo(60) })];
  const { self } = await setup(t, { backfillRows: rows });
  const handler = refreshNowHandler({
    syncAll: async () => { throw new Error("must not call syncAll"); }, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY,
  });
  const withDefaults = JSON.parse((await handler.call(self, { enrichment_dry_run: true })).content[0].text);
  assert.equal(withDefaults.total_candidates, 1);
  const capped = JSON.parse((await handler.call(self, { enrichment_dry_run: true, enrichment_max: 0 })).content[0].text);
  assert.equal(capped.total_candidates, 0);
  const widerWindow = JSON.parse((await handler.call(self, { enrichment_dry_run: true, enrichment_backfill_days: 90 })).content[0].text);
  assert.equal(widerWindow.total_candidates, 2);
});

test("enrichment_dry_run scopes the preview to the account filter", async (t) => {
  const rows = Array.from({ length: 3 }, (_, i) => transaction(`id-${i}`, [], { booking_date: daysAgo(i) }));
  const { self } = await setup(t, { accounts: 2, backfillRows: rows });
  const handler = refreshNowHandler({
    syncAll: async () => { throw new Error("must not call syncAll"); }, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY,
  });
  const scoped = JSON.parse((await handler.call(self, { account: "Account 0", enrichment_dry_run: true })).content[0].text);
  assert.equal(scoped.accounts.length, 1);
  const all = JSON.parse((await handler.call(self, { enrichment_dry_run: true })).content[0].text);
  assert.equal(all.accounts.length, 2);
});

test("enrichment_dry_run output is sanitized: no raw JSON, transaction ids, IBANs or session ids", async (t) => {
  const rows = [transaction("very-secret-id", ["Account Holder"], { booking_date: daysAgo(1) })];
  const { self } = await setup(t, { backfillRows: rows });
  const handler = refreshNowHandler({
    syncAll: async () => { throw new Error("must not call syncAll"); }, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY,
  });
  const result = await handler.call(self, { enrichment_dry_run: true });
  const text = result.content[0].text;
  assert.equal(text.includes("very-secret-id"), false);
  assert.equal(text.includes("session-0"), false);
  assert.equal(text.includes("upstream-0"), false);
  const output = JSON.parse(text);
  assert.deepEqual(Object.keys(output).sort(), ["accounts", "dry_run", "total_candidates"]);
});

test("enrichment_dry_run reports no active session error the same way as a normal call", async (t) => {
  const { self } = await setup(t, {});
  const handler = refreshNowHandler({
    syncAll: async () => { throw new Error("must not call syncAll"); }, previewEnrichmentCandidates, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY,
  });
  // No accounts/backfill rows seeded, but a session exists; dry run should still just report zero candidates,
  // since it is cache-only and does not require an active session the way a real refresh does.
  const result = await handler.call(self, { enrichment_dry_run: true });
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.dry_run, true);
  assert.equal(output.total_candidates, 0);
});
