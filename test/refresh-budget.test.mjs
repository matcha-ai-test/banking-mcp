import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { createEnv, mockEnableBanking } from "./helpers.mjs";
const { Db } = await import("../src/db.ts");
const { syncAll } = await import("../src/sync.ts");
const { matchAccountUids } = await import("../src/util.ts");
const { serializeMcpText, buildSessionWarnings, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY } = await import("../src/mcp-output.ts");
const NOW = Date.parse("2030-01-01T12:00:00Z");
const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
// Read-only HEAD access; literals below are checked against both versions.
const head = execFileSync("git", ["show", "HEAD:src/mcp.ts"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
function compile(body, deps) {
  return Function(...Object.keys(deps), `return ${stripTypeScriptTypes(`(${body})`)}`)(...Object.values(deps));
}
function handler(code) {
  const start = code.indexOf("      async (", code.indexOf('      "refresh_now",'));
  const body = code.slice(start, code.indexOf("\n    );", start)).trim().replace(/^async \(([^)]*)\) =>/, "async function($1)");
  return compile(body, { syncAll, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY });
}
function resolver() {
  const start = source.indexOf("  private async resolveAccountUids(");
  return compile(source.slice(start, source.indexOf("\n  }", start) + 4).trim()
    .replace("private async resolveAccountUids", "async function"), { matchAccountUids });
}
async function setup(t, { sessions = 1, accounts = true, count = 0, date = "2030-01-01", failure = false, backoff = false } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const env = await createEnv();
  t.after(() => env.DB.close());
  const db = new Db(env);
  const routes = {};
  for (let i = 0; i < sessions; i++) {
    await db.insertSession({ id: `session-${i}`, session_id: `upstream-${i}`, psu_type: "personal",
      aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2099-01-01T00:00:00Z" });
    if (accounts) {
      // Two matching accounts and one nonmatching sibling in the owning session.
      for (const suffix of ["a", "b", "unmatched"]) {
        const uid = `account-${i}-${suffix}`;
        await db.upsertAccounts([{ account_uid: uid, session_pk: `session-${i}`, name: suffix === "unmatched" ? "Sibling" : `Selected ${i}`,
          iban: null, currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
        routes[`GET /accounts/${uid}/transactions`] = failure
          ? () => new Response("synthetic failure", { status: 403 }) : { transactions: [] };
        routes[`GET /accounts/${uid}/balances`] = { balances: [] };
      }
    }
  }
  env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = ?, refresh_count_date = ?, backoff_until = ?")
    .run(count, date, backoff ? "2030-01-02T00:00:00Z" : null);
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  const self = { db: () => db, cfg: env, env, resolveAccountUids: resolver(), text: serializeMcpText,
    warnings: async () => buildSessionWarnings(await db.sessionsNeedingWarning()) };
  return { env, db, mock, self };
}
const skipped = [{ session: "Example Bank/personal", skipped: "Daily refresh budget (2) used; serving cached data. Budget resets at midnight UTC." }];
const empty = [{ session: "Example Bank/personal", sessions: 1, accounts_synced: 0, new_transactions: 0, details_fetched: 0, details_failed: 0, errors: [], budget_left_today: 1,
  hint: "No accounts synced for this session. Link the account to the application in the Enable Banking Control Panel (Restricted access), or re-authorize with the correct country (PayPal, for example, is per country): 'npm run auth:link -- --bank=<ASPSP name> --country=<ISO code> [--psu=business]'." }];
const failed = [{ session: "Example Bank/personal", sessions: 1, accounts_synced: 0, new_transactions: 0, details_fetched: 0, details_failed: 0,
  errors: ["account sync failed (Error)", "account sync failed (Error)", "account sync failed (Error)"], budget_left_today: 1 }];
const noSession = { error: "No active bank session. Ask the operator to run 'npm run auth:link -- --bank=<ASPSP name> --country=<ISO code> [--psu=business]' on the operator machine." };
const backedOff = [{ session: "Example Bank/personal", sessions: 0, accounts_synced: 0, new_transactions: 0, details_fetched: 0, details_failed: 0,
  errors: ["session personal: in rate-limit backoff until 2030-01-02T00:00:00Z"], budget_left_today: 1 }];
const success = [{ session: "Example Bank/personal", sessions: 1, accounts_synced: 3, new_transactions: 0, details_fetched: 0, details_failed: 0, errors: [], budget_left_today: 1 }];
for (const [name, options, fixture, calls, finalCount] of [
  ["skipped", { count: 2 }, skipped, 0, 2],
  ["HTTP error", { failure: true }, failed, 3, 1],
  ["empty active session", { accounts: false }, empty, 0, 1],
  ["no active sessions", { sessions: 0 }, noSession, 0, null],
  ["backoff", { backoff: true }, backedOff, 0, 1],
  ["NULL date with exhausted count", { count: 9, date: null }, success, 6, 1],
  ["NULL date error", { count: 2, date: null, failure: true }, failed, 3, 1],
  ["NULL date empty session", { count: 2, date: null, accounts: false }, empty, 0, 1],
]) {
  for (const [version, code] of [["HEAD", head], ["current", source]]) {
    test(`unfiltered ${name}: ${version} matches literal HEAD fixture with real Db and syncAll`, async (t) => {
      const { env, mock, self } = await setup(t, options);
      const result = await handler(code).call(self, {});
      assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify(fixture, null, 2) }] });
      assert.equal(mock.calls.length, calls);
      const rows = env.DB.sqlite.prepare("SELECT refresh_count_today FROM eb_sessions").all();
      assert.deepEqual(rows.map((r) => r.refresh_count_today), finalCount === null ? [] : [finalCount]);
    });
  }
}

test("filtered refresh across two sessions charges only the owner and syncs only its matching accounts", async (t) => {
  const { env, mock, self } = await setup(t, { sessions: 2 });
  const result = await handler(source).call(self, { account: "Selected 1" });
  assert.deepEqual(JSON.parse(result.content[0].text), [{ session: "Example Bank/personal", sessions: 1,
    accounts_synced: 2, new_transactions: 0, details_fetched: 0, details_failed: 0, errors: [], budget_left_today: 1 }]);
  assert.deepEqual(env.DB.sqlite.prepare("SELECT refresh_count_today FROM eb_sessions ORDER BY id").all()
    .map((r) => r.refresh_count_today), [0, 1]);
  assert.deepEqual(mock.calls.map((c) => c.path), ["/accounts/account-1-a/transactions", "/accounts/account-1-a/balances",
    "/accounts/account-1-b/transactions", "/accounts/account-1-b/balances"]);
});

test("concurrent successful refreshes report 1 then 0 left using their own RETURNING row", async (t) => {
  const { db, self } = await setup(t, { accounts: false });
  const charge = db.tryChargeRefreshBudget.bind(db);
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  db.tryChargeRefreshBudget = async (...args) => {
    if (++arrived === 2) release();
    await ready;
    return charge(...args);
  };
  const refresh = handler(source);
  const results = await Promise.all([refresh.call(self, {}), refresh.call(self, {})]);
  assert.deepEqual(results.map((r) => JSON.parse(r.content[0].text)[0].budget_left_today), [1, 0]);
});
