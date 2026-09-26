import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { z } from "zod";
import { createEnv, mockEnableBanking } from "./helpers.mjs";
const { Db } = await import("../src/db.ts");
const { readAuthStatus } = await import("../src/auth-status.ts");
import { buildAuthStatus, serializeMcpText, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY } from "../src/mcp-output.ts";
import { signedAmountCents } from "../src/util.ts";

const NOW = Date.parse("2030-01-01T12:00:00Z");
const session = {
  id: "local-fixture", session_id: "upstream-fixture", psu_type: "personal",
  aspsp_name: "Example Bank", aspsp_country: "SE", status: "active",
  valid_until: "2030-01-31T12:00:00Z", renewal_due: 0,
  refresh_count_date: "2030-01-01", refresh_count_today: 1, backoff_until: null,
  last_live_verified_at: "2030-01-01 11:00:00", last_live_result: "ok",
};
// Hand-written pre-A2 fixture. No expected value comes from the current builder.
const authFixture = {
  note: "Session metadata is cached; last_live_* shows the most recent verified bank call.",
  renewal: "Run 'npm run auth:link -- --bank=<ASPSP name> --country=<ISO code> [--psu=business]' on the operator machine to print a bank re-authorization link.",
  sessions: [{
    bank: "Example Bank", country: "SE", psu_type: "personal", cached: true,
    cached_status: "active", cached_valid_until: "2030-01-31T12:00:00Z",
    days_left_from_cached_valid_until: 30,
    last_live_verified_at: "2030-01-01 11:00:00", last_live_result: "ok",
    renewal_due: false, refreshes_used_today: 1, refresh_budget_per_day: 2,
    rate_limit_backoff_until: null,
  }],
  add_bank: "To connect another bank, first link its accounts to the application in the Enable Banking Control Panel (Restricted access), then run 'npm run auth:link -- --bank=<ASPSP name> --country=<ISO code> [--psu=business]' on the operator machine.",
  add_business: "To add business accounts, run 'npm run auth:link -- --bank=<ASPSP name> --country=<ISO code> [--psu=business]' with --psu=business on the operator machine and complete the bank login. The accounts must be linked to the application first.",
};

// Capture only these actual handlers without importing Worker runtime or unrelated tools.
function handler(name, dependencies) {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf("      async (", source.indexOf(`      "${name}",`));
  const end = source.indexOf("\n    );", start);
  const body = source.slice(start, end).trim().replaceAll("true as const", "true")
    .replace("new Map<string, string[]>()", "new Map()")
    .replace(/^async \(([^)]*)\) =>/, "async function($1)");
  return Function(...Object.keys(dependencies), `return ${stripTypeScriptTypes(`(${body})`)};`)(...Object.values(dependencies));
}

function context(t, syncSummary) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const bumps = [];
  const db = {
    allSessions: async (limit) => { assert.equal(limit, 10); return [session]; },
    activeSessions: async () => [session],
    tryChargeRefreshBudget: async (...args) => { bumps.push(args); return { charged: true, count: 1 }; },
  };
  const self = { db: () => db, cfg: {}, env: {}, resolveAccountUids: async (_db, account) => {
    assert.equal(account, undefined); return null;
  }, warnings: async () => "", text: serializeMcpText };
  const dependencies = {
    readAuthStatus, buildAuthStatus, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY,
    EbClient: class { constructor() { throw new Error("cache-only must not construct client"); } },
    syncAll: async (_env, trigger, filter) => {
      assert.equal(trigger, "refresh_now");
      assert.deepEqual(filter, { sessionPk: "local-fixture", accountUids: undefined, strategy: undefined });
      return syncSummary;
    },
  };
  return { self, dependencies, bumps };
}

function assertOutput(actual, expected) {
  assert.deepEqual(actual, { content: [{ type: "text", text: JSON.stringify(expected, null, 2) }] });
  assert.deepEqual(JSON.parse(actual.content[0].text), expected); // exact keys and values
}

test("get_auth_status with omitted params matches the hand-written pre-change output", async (t) => {
  const { self, dependencies } = context(t);
  assertOutput(await handler("get_auth_status", dependencies).call(self, {}), authFixture);
});

test("refresh_now with omitted params adds only the two enrichment summary counts", async (t) => {
  const { self, dependencies, bumps } = context(t, {
    sessions: 1, accounts_synced: 2, new_transactions: 7, details_fetched: 2, details_failed: 1, errors: [],
  });
  assertOutput(await handler("refresh_now", dependencies).call(self, {}), [{
    session: "Example Bank/personal", sessions: 1, accounts_synced: 2,
    new_transactions: 7, details_fetched: 2, details_failed: 1, errors: [], budget_left_today: 1,
  }]);
  assert.deepEqual(bumps, [["local-fixture", "2030-01-01", 2]]);
});


test("verify=true adds all live fields while preserving sync evidence and excluding stored internals", async (t) => {
  const { self, dependencies } = context(t);
  const live = { live_status: "AUTHORIZED", live_valid_until: null, live_error: null,
    live_cached: false, live_verified_at: "2030-01-01T12:00:00.000Z" };
  dependencies.readAuthStatus = async (_db, _client, verify) => {
    assert.equal(verify, true);
    return { sessions: [{ ...session, live_verify_result: "internal-only" }], liveResults: [live] };
  };
  const expected = { ...authFixture, sessions: [{ ...authFixture.sessions[0], ...live }] };
  const actual = await handler("get_auth_status", dependencies).call(self, { verify: true });
  assert.deepEqual(JSON.parse(actual.content[0].text), expected);
  assert.equal(actual.content[0].text.includes("internal-only"), false);
});

// Literal pre-details output, including pending rows and signed amounts.
// Step 2 deliberately adds amount_cents after amount and appends the category
// fields to every row (additive: the earlier keys keep their order and values). The account has no IBAN
// or identification hash, so it has no stable account_ref and therefore no
// writable transaction_key; with no rules it is uncategorized.
const uncategorized = { category: null, category_id: null, category_source: "uncategorized", category_rule_id: null };
const transactionsFixture = {
  booked: [{ account: "Primary", booking_date: "2030-01-01", amount: -12.34, amount_cents: -1234,
    currency: "EUR", counterparty: "Example payee", description: "Example purchase",
    account_ref: null, transaction_key: null, ...uncategorized, category_override_revision: null }],
  pending: [{ account: "Primary", booking_date: "2030-01-02", amount: 5.67, amount_cents: 567,
    currency: "EUR", counterparty: null, description: "Example refund", status: "PENDING",
    account_ref: null, ...uncategorized, category_provisional: true }],
  note: "Amounts are signed: negative = money out, positive = money in. Cached data: see last_synced_at via list_accounts.",
};

test("get_transactions with omitted params matches the hand-written pre-change output", async (t) => {
  const { self, dependencies } = context(t);
  const env = await createEnv();
  t.after(() => env.DB.close());
  const mock = mockEnableBanking({});
  t.after(() => mock.restore());
  const db = new Db(env);
  await db.insertSession(session);
  await db.upsertAccounts([{ account_uid: "account", session_pk: session.id, name: "Primary", iban: null,
    currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
  const row = { account_uid: "account", booking_date: "2030-01-01", value_date: null,
    amount_cents: 1234, currency: "EUR", credit_debit: "DBIT", counterparty: "Example payee",
    remittance_info: "Example purchase", entry_reference: "fixture", dedup_key: "fixture",
    raw: JSON.stringify({ transaction_id: "detail-id", note: "Must not add detail fields to list output" }) };
  await db.insertTransactionsIgnore([row]);
  await db.replacePending("account", [{ ...row, booking_date: "2030-01-02", amount_cents: 567,
    credit_debit: "CRDT", counterparty: null, remittance_info: "Example refund" }]);
  self.db = () => db;
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf('      "get_transactions",');
  const end = source.indexOf("      async (", start);
  const config = source.slice(start + '      "get_transactions",'.length, end).trim().replace(/,$/, "");
  const { inputSchema } = Function("z", `return (${config})`)(z);
  const input = z.object(inputSchema).parse({});
  assert.deepEqual(input, { limit: 100, include_pending: true });
  const moneyFunctions = source.slice(source.indexOf("function money("), source.indexOf("export class BankingMCP"));
  dependencies.signed = Function("signedAmountCents", `${stripTypeScriptTypes(moneyFunctions)}; return signed;`)(signedAmountCents);
  dependencies.signedAmountCents = signedAmountCents;
  ({ annotateTransactions: dependencies.annotateTransactions, categoryFields: dependencies.categoryFields } = await import("../src/categories.ts"));
  assertOutput(await handler("get_transactions", dependencies).call(self, input), transactionsFixture);
  assert.equal(mock.calls.length, 0);
  assert.equal((await db.activeSessions())[0].refresh_count_today, 0);
});

for (const first of ["details", "refresh_now"]) {
  test(`concurrent details and refresh_now cannot overspend or overwrite a charge (${first} wins)`, async (t) => {
    const { self, dependencies } = context(t);
    const { readTransactionDetails } = await import("../src/transaction-details.ts");
    const { EbClient } = await import("../src/eb.ts");
    const env = await createEnv();
    t.after(() => env.DB.close());
    const db = new Db(env);
    await db.insertSession(session);
    await db.upsertAccounts([{ account_uid: "account", session_pk: session.id, name: "Primary", iban: null,
      currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
    await db.insertTransactionsIgnore([{ account_uid: "account", booking_date: "2030-01-01", value_date: null,
      amount_cents: 1234, currency: "EUR", credit_debit: "DBIT", counterparty: null,
      remittance_info: "Example", entry_reference: "fixture", dedup_key: "fixture",
      raw: JSON.stringify({ transaction_id: "detail-id" }) }]);
    env.DB.sqlite.prepare("UPDATE eb_sessions SET refresh_count_today = 1, refresh_count_date = '2030-01-01'").run();
    const mock = mockEnableBanking({ "GET /accounts/account/transactions/detail-id": {} });
    t.after(() => mock.restore());
    self.db = () => db;
    let syncCalls = 0;
    dependencies.syncAll = async () => {
      syncCalls++;
      assert.equal((await db.activeSessions())[0].refresh_count_today, 2);
      return { sessions: 1, accounts_synced: 1, new_transactions: 0, details_fetched: 0, details_failed: 0, errors: [] };
    };
    // Force the chosen winner to reserve, then let the other tool contend while
    // the winner is still suspended before dispatch. The Db method stays real.
    const charge = db.tryChargeRefreshBudget.bind(db);
    let firstArrived;
    const ready = new Promise((resolve) => { firstArrived = resolve; });
    let release;
    const otherArrived = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    db.tryChargeRefreshBudget = async (...args) => {
      const isFirst = ++calls === 1;
      const result = await charge(...args);
      if (isFirst) { firstArrived(); await otherArrived; } else { release(); }
      return result;
    };
    const details = () => readTransactionDetails(db, () => new EbClient(env),
      { booking_date: "2030-01-01", amount: -12.34 }, null, NOW);
    const refresh = () => handler("refresh_now", dependencies).call(self, {});
    const winner = first === "details" ? details() : refresh();
    await ready;
    const loser = first === "details" ? refresh() : details();
    const [win, lose] = await Promise.all([winner, loser]);
    assert.equal((await db.activeSessions())[0].refresh_count_today, 2);
    assert.equal(mock.calls.length, first === "details" ? 1 : 0);
    assert.equal(syncCalls, first === "refresh_now" ? 1 : 0);
    const refreshResult = JSON.parse((first === "refresh_now" ? win : lose).content[0].text);
    if (first === "details") {
      assert.equal(win.budget_left_today, 0);
      assert.deepEqual(refreshResult, [{ session: "Example Bank/personal",
        skipped: "Daily refresh budget (2) used; serving cached data. Budget resets at midnight UTC." }]);
    } else {
      assert.equal(refreshResult[0].budget_left_today, 0);
      assert.deepEqual(lose, { error: "Daily refresh budget (2) used; serving cached data. Budget resets at midnight UTC.", budget_left_today: 0 });
    }
  });
}
