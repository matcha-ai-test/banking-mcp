import assert from "node:assert/strict";
import test from "node:test";
import { createEnv, mockEnableBanking } from "./helpers.mjs";

const { EbClient } = await import("../src/eb.ts");
const { Db } = await import("../src/db.ts");
const { syncAll } = await import("../src/sync.ts");

async function setup(t, routes) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  return { env, mock, client: new EbClient(env) };
}

test("getSession encodes the session ID as one path segment", async (t) => {
  const id = "session/with?query#fragment% &å";
  const path = `/sessions/${encodeURIComponent(id)}`;
  const { client, mock } = await setup(t, { [`GET ${path}`]: { status: "AUTHORIZED" } });
  assert.deepEqual(await client.getSession(id), { status: "AUTHORIZED" });
  assert.equal(mock.calls[0].path, path);
  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].search.size, 0);
});

for (const strategy of [undefined, "default", "longest"]) {
  test(`getTransactions query preserves existing options with strategy ${strategy}`, async (t) => {
    const { client, mock } = await setup(t, { "GET /accounts/account/transactions": { transactions: [] } });
    await client.getTransactions("account", { dateFrom: "2026-01-01", dateTo: "2026-02-01", continuationKey: "next?&/#", strategy });
    assert.deepEqual(Object.fromEntries(mock.calls[0].search), {
      date_from: "2026-01-01", date_to: "2026-02-01", continuation_key: "next?&/#",
      ...(strategy ? { strategy } : {}),
    });
  });

  test(`syncAll forwards strategy ${strategy} to every page and preserves session filters`, async (t) => {
    const { env, mock } = await setup(t, {
      "GET /accounts/account/transactions": (url) => ({ transactions: [], continuation_key: url.searchParams.has("continuation_key") ? null : "page-2" }),
      "GET /accounts/account/balances": { balances: [] },
    });
    const db = new Db(env);
    for (const id of ["selected", "other"]) {
      await db.insertSession({ id, session_id: `upstream-${id}`, psu_type: "personal", aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2099-01-01T00:00:00Z" });
      await db.upsertAccounts([{ account_uid: id === "selected" ? "account" : "other-account", session_pk: id, name: "Example account", iban: null, currency: "EUR", psu_type: "personal", product: null, last_synced_at: null }]);
    }
    const result = await syncAll(env, "test", { sessionPk: "selected", ...(strategy ? { strategy } : {}) });
    assert.equal(result.accounts_synced, 1);
    assert.deepEqual(result.errors, []);
    const pages = mock.calls.filter((c) => c.path.endsWith("/transactions"));
    assert.equal(pages.length, 2);
    for (const page of pages) assert.equal(page.search.get("strategy"), strategy ?? null);
    assert.equal(pages[1].search.get("continuation_key"), "page-2");
    assert.equal(mock.calls.length, 3);
  });
}

test("5xx session verification makes exactly one GET", async (t) => {
  const { client, mock } = await setup(t, {
    "GET /sessions/session": () => new Response("sensitive-upstream-body", { status: 503 }),
  });
  await assert.rejects(client.getSession("session"), { message: "Enable Banking request failed (503)" });
  assert.equal(mock.calls.length, 1);
});

for (const operation of ["transactions", "balances"]) {
  test(`${operation} retains three GET retries after 5xx`, { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client, mock } = await setup(t, {
      [`GET /accounts/account/${operation}`]: () => new Response("unavailable", { status: 503 }),
    });
    const result = assert.rejects(operation === "transactions" ? client.getTransactions("account") : client.getBalances("account"));
    for (let i = 0; i < 4; i++) {
      while (mock.calls.length <= i) await new Promise(setImmediate);
      await new Promise(setImmediate);
      t.mock.timers.tick(4000);
    }
    await result;
    assert.equal(mock.calls.length, 4);
  });
}
