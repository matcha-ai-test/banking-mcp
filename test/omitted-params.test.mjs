import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import "./helpers.mjs";
const { readAuthStatus } = await import("../src/auth-status.ts");
import { buildAuthStatus, serializeMcpText, AUTH_LINK_CMD, REFRESH_BUDGET_PER_DAY } from "../src/mcp-output.ts";

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
    renewal_due: false, refreshes_used_today: 1, refresh_budget_per_day: 3,
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
  return Function(...Object.keys(dependencies), `return (${body});`)(...Object.values(dependencies));
}

function context(t, syncSummary) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const bumps = [];
  const db = {
    allSessions: async (limit) => { assert.equal(limit, 10); return [session]; },
    activeSessions: async () => [session],
    bumpRefreshCount: async (...args) => { bumps.push(args); },
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

test("refresh_now with omitted params matches the hand-written pre-change output", async (t) => {
  const { self, dependencies, bumps } = context(t, {
    sessions: 1, accounts_synced: 2, new_transactions: 7, errors: [],
  });
  assertOutput(await handler("refresh_now", dependencies).call(self, {}), [{
    session: "Example Bank/personal", sessions: 1, accounts_synced: 2,
    new_transactions: 7, errors: [], budget_left_today: 1,
  }]);
  assert.deepEqual(bumps, [["local-fixture", 2, "2030-01-01"]]);
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
