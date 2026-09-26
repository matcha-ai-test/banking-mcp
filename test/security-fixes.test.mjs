// B1-B6 and B8 from the 2026-09-23 sweep: grant/password binding, closed OAuth
// endpoints while unconfigured, parked identity conflicts plus the operator
// escape hatch, generic tool errors, invisible labels, the /mcp wrong-password
// limiter, and a quiet identity backfill.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

import { createEnv, mockEnableBanking } from "./helpers.mjs";
import "./cloudflare-stub.mjs";

const { checkGrantProps, grantFingerprint, grantProps } = await import("../src/grant.ts");
const { guardedApiHandler, refreshGrantCheck } = await import("../src/grant-guard.ts");
const { handleAuthorize } = await import("../src/oauth.ts");
const { Db } = await import("../src/db.ts");
const { assignAccountIdentities, backfillAccountIdentities, canonicalIban, conflictKeyOf, naturalIdentityOf } = await import("../src/identity.ts");
const { __resetIdentityBackfillForTests, ensureIdentityBackfill } = await import("../src/bootstrap.ts");
const { compactJson, serializeMcpText, toolErrorBoundary } = await import("../src/mcp-output.ts");
const { checkMutationBudget, enforceArgBudget } = await import("../src/mutation-guard.ts");
const { ACCOUNT_REF_RE, containsIbanLike, matchAccountUids, maskIban, normalizeText } = await import("../src/util.ts");
const { attachSql, listConflictsSql, newIdentitySql, validateAccountUid, validateIdentityRef } = await import("../scripts/lib/identity-resolve.mjs");

const CLOUD = "https://worker.example.test";
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });

async function freshEnv(t) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  return env;
}

// ------------------------------------------------------------------ B1 grants

test("B1: a grant approved under the current password matches, a legacy grant is flagged, a rotated one mismatches", async () => {
  const props = await grantProps("old-secret");
  assert.equal(props.user, "operator");
  assert.match(props.secretFp, /^[0-9a-f]{16}$/);
  assert.notEqual(props.secretFp, "old-secret".slice(0, 16));
  assert.equal(await checkGrantProps(props, "old-secret"), "match");
  assert.equal(await checkGrantProps(props, "new-secret"), "mismatch");
  assert.equal(await checkGrantProps({ user: "operator" }, "new-secret"), "legacy");
  assert.equal(await checkGrantProps(undefined, "new-secret"), "legacy");
  assert.equal(await checkGrantProps(props, undefined), "mismatch", "no secret configured verifies nothing");
  assert.equal(await checkGrantProps({ secretFp: 42 }, "old-secret"), "mismatch");
});

test("B1: the fingerprint is domain-separated, not a bare hash of the secret", async () => {
  const { sha256Hex } = await import("../src/util.ts");
  assert.notEqual(await grantFingerprint("s"), (await sha256Hex("s")).slice(0, 16));
});

function recordingInner() {
  const calls = [];
  return { calls, handler: { fetch: async (req) => (calls.push(req.url), new Response("inner", { status: 200 })) } };
}

test("B1: /mcp via OAuth refuses a grant from a previous password with the provider's invalid_token shape", async () => {
  const { calls, handler } = recordingInner();
  const guarded = guardedApiHandler(handler);
  const env = { MCP_SECRET: "new-secret" };
  const res = await guarded.fetch(new Request(`${CLOUD}/mcp`), env, { ...ctx(), props: await grantProps("old-secret") });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") ?? "", /error="invalid_token"/);
  assert.match(res.headers.get("WWW-Authenticate") ?? "", /resource_metadata="https:\/\/worker\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await res.json()).error, "invalid_token");
  assert.equal(calls.length, 0, "the MCP handler never ran");
});

test("B1: a matching grant and a legacy grant both reach the MCP handler", async () => {
  const { calls, handler } = recordingInner();
  const guarded = guardedApiHandler(handler);
  const env = { MCP_SECRET: "s" };
  assert.equal((await guarded.fetch(new Request(`${CLOUD}/mcp`), env, { ...ctx(), props: await grantProps("s") })).status, 200);
  assert.equal((await guarded.fetch(new Request(`${CLOUD}/mcp`), env, { ...ctx(), props: { user: "operator" } })).status, 200);
  assert.equal(calls.length, 2);
});

test("B1: refresh stamps a legacy grant, keeps a matching one, and refuses a rotated one", async () => {
  const cb = refreshGrantCheck({ MCP_SECRET: "s" });
  const stamped = await cb({ grantType: "refresh_token", props: { user: "operator" } });
  assert.deepEqual(stamped, { newProps: { user: "operator", secretFp: await grantFingerprint("s") } });
  assert.equal(await cb({ grantType: "refresh_token", props: await grantProps("s") }), undefined);
  assert.equal(await cb({ grantType: "authorization_code", props: await grantProps("other") }), undefined, "only refresh is checked here");
  await assert.rejects(cb({ grantType: "refresh_token", props: await grantProps("old") }), (e) => e.code === "invalid_grant");
});

function fakeProvider() {
  const completed = [];
  return {
    completed,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ clientId: "c", redirectUri: "https://client.example/cb", scope: [] }),
      completeAuthorization: async (opts) => (completed.push(opts), { redirectTo: "https://client.example/cb?code=x&state=y" }),
    },
  };
}

function authorizePost(password) {
  const body = new URLSearchParams({ password });
  return new Request(`${CLOUD}/authorize?client_id=c`, { method: "POST", body, headers: { "CF-Connecting-IP": "203.0.113.9" } });
}

test("B1: approval stores the password fingerprint in the grant props", async (t) => {
  const env = await freshEnv(t);
  const provider = fakeProvider();
  const res = await handleAuthorize(authorizePost(env.MCP_SECRET), { ...env, ...provider });
  assert.equal(res.status, 302);
  assert.deepEqual(provider.completed[0].props, await grantProps(env.MCP_SECRET));
});

test("B2: a placeholder connection password can never approve a grant", async (t) => {
  const env = { ...(await freshEnv(t)), MCP_SECRET: "generated-connection-password" };
  const provider = fakeProvider();
  const res = await handleAuthorize(authorizePost("generated-connection-password"), { ...env, ...provider });
  assert.equal(res.status, 401);
  assert.equal(provider.completed.length, 0);
});

// ------------------------------------------------------ B2 closed endpoints

test("B2: /authorize, /token and /register answer 503 while unconfigured", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = { ...(await freshEnv(t)), MCP_SECRET: "generated-connection-password" };
  for (const [method, path] of [["GET", "/authorize?client_id=x"], ["POST", "/token"], ["POST", "/register"]]) {
    const res = await worker.fetch(new Request(`${CLOUD}${path}`, { method, body: method === "POST" ? "{}" : undefined }), env, ctx());
    assert.equal(res.status, 503, path);
    assert.match(await res.text(), /Not configured/, path);
  }
});

test("B2: once configured the OAuth endpoints are served by the provider again", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = { ...(await freshEnv(t)), OAUTH_KV: memoryKv() };
  const res = await worker.fetch(
    new Request(`${CLOUD}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/cb"], client_name: "t", token_endpoint_auth_method: "none" }),
    }),
    env,
    ctx()
  );
  assert.equal(res.status, 201);
});

function memoryKv() {
  const m = new Map();
  return {
    async get(k, opts) {
      const v = m.get(k);
      if (v === undefined) return null;
      return opts?.type === "json" || opts === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix = "" } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// ---------------------------------------------------- B6 wrong-password limit

test("B6: repeated wrong x-api-key attempts from one client trip a 429; another client is unaffected", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = await freshEnv(t);
  const wrong = (ip) => new Request(`${CLOUD}/mcp`, { method: "POST", headers: { "x-api-key": "wrong", "CF-Connecting-IP": ip } });
  for (let i = 0; i < 20; i++) assert.equal((await worker.fetch(wrong("198.51.100.1"), env, ctx())).status, 401, `attempt ${i + 1}`);
  const blocked = await worker.fetch(wrong("198.51.100.1"), env, ctx());
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("WWW-Authenticate"), null);
  assert.equal((await worker.fetch(wrong("198.51.100.2"), env, ctx())).status, 401);
});

test("B6: a correct password is never counted by the limiter", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = await freshEnv(t);
  const ok = new Request(`${CLOUD}/mcp`, { method: "POST", headers: { "x-api-key": env.MCP_SECRET, "CF-Connecting-IP": "198.51.100.3" } });
  // No MCP_OBJECT binding here, so the allowed request fails further in; what
  // matters is that it went past the gate without touching rate_limit.
  await worker.fetch(ok, env, ctx());
  const rows = env.DB.sqlite.prepare("SELECT key FROM rate_limit WHERE key LIKE 'mcp-secret-fail:%'").all();
  assert.equal(rows.length, 0);
});

test("B6: a bearer the OAuth provider rejects counts in the same bucket as a wrong x-api-key", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = { ...(await freshEnv(t)), OAUTH_KV: memoryKv() };
  const ip = "198.51.100.4";
  const bearer = () => new Request(`${CLOUD}/mcp`, { method: "POST", headers: { authorization: "Bearer guessed-token", "CF-Connecting-IP": ip } });
  const apiKey = () => new Request(`${CLOUD}/mcp`, { method: "POST", headers: { "x-api-key": "wrong", "CF-Connecting-IP": ip } });
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(bearer(), env, ctx())).status, 401, `bearer ${i + 1}`);
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(apiKey(), env, ctx())).status, 401, `api key ${i + 1}`);
  // 20 wrong credentials in total: the 21st is refused whichever header it uses.
  assert.equal((await worker.fetch(bearer(), env, ctx())).status, 429);
  assert.equal((await worker.fetch(apiKey(), env, ctx())).status, 429);
});

test("B6: an unauthenticated /mcp request (OAuth discovery) is not counted", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = { ...(await freshEnv(t)), OAUTH_KV: memoryKv() };
  const bare = new Request(`${CLOUD}/mcp`, { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.5" } });
  assert.equal((await worker.fetch(bare, env, ctx())).status, 401);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limit").get().n, 0);
});

// ------------------------------------------------------------- /register limit

test("/register allows 10 registrations per client per hour, then answers 429 JSON", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  const env = { ...(await freshEnv(t)), OAUTH_KV: memoryKv() };
  const register = (ip) => new Request(`${CLOUD}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ redirect_uris: ["https://client.example/cb"], client_name: "t", token_endpoint_auth_method: "none" }),
  });
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(register("198.51.100.6"), env, ctx())).status, 201, `registration ${i + 1}`);
  const blocked = await worker.fetch(register("198.51.100.6"), env, ctx());
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get("Content-Type"), /application\/json/);
  assert.equal((await blocked.json()).error, "too_many_requests");
  assert.equal((await worker.fetch(register("198.51.100.7"), env, ctx())).status, 201);
});

// ------------------------------------------------------------- cron housekeeping

test("the scheduled handler prunes stale rate_limit rows and used or expired auth_state rows", async (t) => {
  const worker = (await import("../src/index.ts")).default;
  // Unconfigured, so the handler prunes and then skips the bank sync.
  const env = { ...(await freshEnv(t)), MCP_SECRET: "generated-connection-password" };
  const sql = env.DB.sqlite;
  sql.prepare("INSERT INTO rate_limit (key, count, window_start) VALUES ('old', 3, datetime('now', '-2 days')), ('fresh', 1, datetime('now'))").run();
  sql.prepare(`INSERT INTO auth_state (state, psu_type, created_at, used_at) VALUES
    ('used', 'personal', datetime('now'), datetime('now')),
    ('expired', 'personal', datetime('now', '-1 hour'), NULL),
    ('live', 'personal', datetime('now'), NULL)`).run();
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p), passThroughOnException() {} });
  await Promise.all(pending);
  assert.deepEqual(sql.prepare("SELECT key FROM rate_limit ORDER BY key").all().map((r) => r.key), ["fresh"]);
  assert.deepEqual(sql.prepare("SELECT state FROM auth_state ORDER BY state").all().map((r) => r.state), ["live"]);
});

// ------------------------------------------------------------- B3 conflicts

async function seedConflict(env) {
  const db = new Db(env);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  // A hash-only identity first, then a row carrying the same hash plus an IBAN.
  await db.upsertAccounts([{ account_uid: "old-1", session_pk: "s", name: "Kort", iban: null, identification_hash: "h1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  await assignAccountIdentities(db, await db.accountsWithoutIdentity());
  const hashIdentity = await db.accountIdentityOf("old-1");
  await db.upsertAccounts([{ account_uid: "new-1", session_pk: "s", name: "Kort", iban: "SE45 5000 0000 0583 9825 7466", identification_hash: "h1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  return { db, hashIdentity };
}

test("B3: a conflict is recorded once and not retried while the inputs are unchanged", async (t) => {
  const env = await freshEnv(t);
  const { db } = await seedConflict(env);
  const first = await backfillAccountIdentities(db);
  assert.equal(first.conflicts, 1);
  const row = env.DB.sqlite.prepare("SELECT identity_conflict_key, account_identity_id FROM accounts WHERE account_uid = 'new-1'").get();
  assert.match(row.identity_conflict_key, /^[0-9a-f]{32}$/);
  assert.equal(row.account_identity_id, null);
  assert.deepEqual(await backfillAccountIdentities(db), { assigned: 0, conflicts: 0, unavailable: 0, errors: 0 });
});

test("B3: changed inputs make a parked row eligible again", async (t) => {
  const env = await freshEnv(t);
  const { db } = await seedConflict(env);
  await backfillAccountIdentities(db);
  env.DB.sqlite.prepare("UPDATE accounts SET identification_hash = 'h2' WHERE account_uid = 'new-1'").run();
  const again = await backfillAccountIdentities(db);
  assert.equal(again.assigned, 1);
});

test("B3: a transient error is never parked", async (t) => {
  const env = await freshEnv(t);
  const { db } = await seedConflict(env);
  const flaky = Object.create(db);
  flaky.identityByIban = async () => {
    throw new Error("D1_ERROR: flaky");
  };
  const res = await backfillAccountIdentities(flaky);
  assert.equal(res.errors, 1);
  const row = env.DB.sqlite.prepare("SELECT identity_conflict_key FROM accounts WHERE account_uid = 'new-1'").get();
  assert.equal(row.identity_conflict_key, null);
});

test("B3: conflictKeyOf changes with every natural-identity input", async () => {
  const base = { iban: "SE1", identificationHash: "h", currency: "SEK", psuType: "personal" };
  const k = await conflictKeyOf(base);
  for (const change of [{ iban: "SE2" }, { identificationHash: "g" }, { currency: "EUR" }, { psuType: "business" }]) {
    assert.notEqual(await conflictKeyOf({ ...base, ...change }), k, JSON.stringify(change));
  }
});

function runSql(env, statements) {
  for (const sql of statements) env.DB.sqlite.exec(sql);
}

test("B3 escape hatch: list shows the parked row with only the IBAN's last four", async (t) => {
  const env = await freshEnv(t);
  const { db, hashIdentity } = await seedConflict(env);
  await backfillAccountIdentities(db);
  const rows = env.DB.sqlite.prepare(listConflictsSql()).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_uid, "new-1");
  assert.equal(rows[0].iban_last4, "7466");
  assert.equal(rows[0].hash_identity, hashIdentity);
  assert.equal(JSON.stringify(rows).includes("5000"), false);
});

test("B3 escape hatch: attach points the row at the identity, which inherits the IBAN and keeps its label", async (t) => {
  const env = await freshEnv(t);
  const { db, hashIdentity } = await seedConflict(env);
  await db.upsertLabel(hashIdentity, "Kreditkort", null);
  await backfillAccountIdentities(db);
  runSql(env, attachSql("new-1", hashIdentity));
  assert.equal(await db.accountIdentityOf("new-1"), hashIdentity);
  assert.equal((await db.identityById(hashIdentity)).iban, "SE4550000000058398257466");
  const rows = await db.allAccountsWithBank();
  assert.equal(rows.find((r) => r.account_uid === "new-1").label, "Kreditkort");
  assert.deepEqual(matchAccountUids(rows, "Kreditkort").sort(), ["new-1", "old-1"]);
  // A re-authorized generation now resolves by IBAN instead of conflicting.
  await db.upsertAccounts([{ account_uid: "new-2", session_pk: "s", name: "Kort", iban: "SE4550000000058398257466", identification_hash: "h1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const res = await assignAccountIdentities(db, [(await db.accountsWithoutIdentity()).find((r) => r.account_uid === "new-2")]);
  assert.deepEqual(res.get("new-2"), { ok: true, id: hashIdentity, created: false });
  // Re-running attach is a no-op.
  runSql(env, attachSql("new-1", hashIdentity));
  assert.equal(await db.accountIdentityOf("new-1"), hashIdentity);
});

test("B3 escape hatch: attach refuses an identity with another currency", async (t) => {
  const env = await freshEnv(t);
  const { db, hashIdentity } = await seedConflict(env);
  env.DB.sqlite.prepare("UPDATE account_identities SET currency = 'EUR' WHERE id = ?").run(hashIdentity);
  runSql(env, attachSql("new-1", hashIdentity));
  assert.equal(await db.accountIdentityOf("new-1"), null);
  assert.equal((await db.identityById(hashIdentity)).iban, null);
});

test("B3 escape hatch: new gives a fresh unlabelled identity; the old one keeps hash and label", async (t) => {
  const env = await freshEnv(t);
  const { db, hashIdentity } = await seedConflict(env);
  await db.upsertLabel(hashIdentity, "Kreditkort", null);
  await backfillAccountIdentities(db);
  const newId = "0123456789abcdef0123456789abcdef";
  runSql(env, newIdentitySql("new-1", newId));
  assert.equal(await db.accountIdentityOf("new-1"), newId);
  const fresh = await db.identityById(newId);
  assert.equal(fresh.iban, "SE4550000000058398257466");
  assert.equal(fresh.identification_hash, null);
  assert.equal((await db.identityById(hashIdentity)).identification_hash, "h1");
  const rows = await db.allAccountsWithBank();
  assert.equal(rows.find((r) => r.account_uid === "new-1").label ?? null, null);
  assert.equal(rows.find((r) => r.account_uid === "old-1").label, "Kreditkort");
  assert.equal(env.DB.sqlite.prepare("SELECT identity_conflict_key FROM accounts WHERE account_uid = 'new-1'").get().identity_conflict_key, null);
});

test("B3 escape hatch: inputs that could escape the SQL literal are refused", () => {
  for (const bad of ["x' OR 1=1 --", "a;b", "a b", "", "a".repeat(65), "å"]) assert.throws(() => validateAccountUid(bad), undefined, bad);
  for (const bad of ["0123456789ABCDEF0123456789ABCDEF", "abc", "0123456789abcdef0123456789abcde'", undefined]) {
    assert.throws(() => validateIdentityRef(bad), undefined, String(bad));
  }
  assert.throws(() => attachSql("ok-uid", "nope"));
  assert.throws(() => newIdentitySql("x'y", "0123456789abcdef0123456789abcdef"));
});

// --------------------------------------------------------------- B8 quiet log

test("B8: a backfill with nothing to do logs nothing", async (t) => {
  const env = await freshEnv(t);
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a);
  t.after(() => (console.log = original));
  __resetIdentityBackfillForTests();
  await ensureIdentityBackfill(env);
  await assignAccountIdentities(new Db(env), []);
  console.log = original;
  assert.equal(logs.filter((l) => l[0] === "identity assignment").length, 0);
});

test("B8: a backfill that assigns something still logs its counts", async (t) => {
  const env = await freshEnv(t);
  const db = new Db(env);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await db.upsertAccounts([{ account_uid: "a", session_pk: "s", name: "n", iban: "SE4550000000058398257466", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a);
  t.after(() => (console.log = original));
  await backfillAccountIdentities(db);
  console.log = original;
  assert.deepEqual(logs.find((l) => l[0] === "identity assignment")?.[1], { assigned: 1, conflicts: 0, unavailable: 0, errors: 0 });
});

// ------------------------------------------------------------ B4 tool errors

test("B4: an unexpected throw becomes a generic error with no D1 or SQL text", async (t) => {
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a);
  t.after(() => (console.error = original));
  const wrapped = toolErrorBoundary("get_transactions", async () => {
    const e = new Error("D1_ERROR: no such column: secret_col at SELECT * FROM transactions WHERE iban = 'SE45...'");
    e.name = "D1Error";
    throw e;
  });
  const res = await wrapped({});
  console.error = original;
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.deepEqual(JSON.parse(text), { error: "internal_error", reason: "unexpected_failure" });
  assert.doesNotMatch(text, /D1|SELECT|column|SE45/);
  assert.deepEqual(errors[0][1], { tool: "get_transactions", error: "D1Error" });
  assert.doesNotMatch(JSON.stringify(errors), /no such column|SELECT/);
});

test("B4: a successful or intentionally-failed result passes through unchanged", async () => {
  const ok = { content: [{ type: "text", text: "{}" }] };
  assert.equal(await toolErrorBoundary("x", async () => ok)(), ok);
  const intentional = { content: [{ type: "text", text: '{"error":"not_found"}' }], isError: true };
  assert.equal(await toolErrorBoundary("x", async () => intentional)(), intentional);
});

test("B4: every tool is registered through the error boundary", () => {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const direct = source.match(/this\.server\.registerTool\(/g) ?? [];
  assert.equal(direct.length, 1, "only the boundary wrapper itself calls registerTool");
  assert.match(source, /this\.server\.registerTool\(name, config, toolErrorBoundary\(name, handler\)/);
  const viaWrapper = source.match(/^ {4}this\.tool\(\n {6}"([a-z_]+)"/gm) ?? [];
  assert.ok(viaWrapper.length >= 11, `expected at least 11 tools via this.tool, got ${viaWrapper.length}`);
});

test("B4: a D1 failure inside a real tool handler reaches the client as the generic error", async (t) => {
  const env = await freshEnv(t);
  const mock = mockEnableBanking({});
  t.after(() => mock.restore());
  const handler = sliceHandler("list_accounts", { compactJson, maskIban });
  const brokenDb = { allAccountsWithBank: async () => { throw new Error("D1_ERROR: SELECT secret"); }, balances: async () => [] };
  const self = { db: () => brokenDb, warnings: async () => "", text: serializeMcpText };
  const res = await toolErrorBoundary("list_accounts", (...a) => handler.call(self, ...a))({});
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.content[0].text, /SELECT|D1_ERROR/);
  void env;
});

// ---------------------------------------------------------------- B5 labels

function sliceHandler(name, dependencies) {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf("      async (", source.indexOf(`      "${name}",`));
  const end = source.indexOf("\n    );", start);
  const body = source.slice(start, end).trim().replace(/^async \(([^)]*)\) =>/, "async function($1)");
  const money = source.slice(source.indexOf("function money("), source.indexOf("function signed("));
  return Function(...Object.keys(dependencies), `${stripTypeScriptTypes(money)}; return ${stripTypeScriptTypes(`(${body})`)};`)(...Object.values(dependencies));
}

const labelDeps = { compactJson, containsIbanLike, checkMutationBudget, enforceArgBudget, maskIban, normalizeText, ACCOUNT_REF_RE, canonicalIban };

async function labelSetup(t) {
  const env = await freshEnv(t);
  const mock = mockEnableBanking({});
  t.after(() => mock.restore());
  const db = new Db(env);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const seed = async (uid, iban) => {
    await db.upsertAccounts([{ account_uid: uid, session_pk: "s", name: `Konto ${uid}`, iban, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
    await assignAccountIdentities(db, (await db.accountsWithoutIdentity()).filter((r) => r.account_uid === uid));
    return db.accountIdentityOf(uid);
  };
  const set = async (args) => {
    const self = { db: () => db, resolveAccountUids: async () => null, warnings: async () => "", text: serializeMcpText };
    return JSON.parse((await sliceHandler("set_account_label", labelDeps).call(self, args)).content[0].text);
  };
  return { db, seed, set };
}

test("B5: normalizeText drops invisible characters and treats NBSP as a space", () => {
  assert.equal(normalizeText("​​​"), "");
  assert.equal(normalizeText("ㅤㅤㅤ"), "");
  assert.equal(normalizeText("   "), "");
  assert.equal(normalizeText("Var​dag"), "Vardag");
  assert.equal(normalizeText("Spar  konto"), "Spar konto");
  assert.equal(normalizeText("﻿Hushåll⁠"), "Hushåll");
});

test("B5: an invisible-only or NBSP-only label is rejected as too short", async (t) => {
  const { seed, set } = await labelSetup(t);
  const ref = await seed("u1", "SE4550000000058398257466");
  for (const label of ["​​​", "   ", "ㅤㅤㅤ", "a​​​"]) {
    assert.deepEqual(await set({ account_ref: ref, label, dry_run: true }), { error: "invalid_argument", field: "label", reason: "length" }, JSON.stringify(label));
  }
});

test("B5: a label padded with invisible characters is stored clean and collides with its visible twin", async (t) => {
  const { db, seed, set } = await labelSetup(t);
  const a = await seed("u1", "SE4550000000058398257466");
  const b = await seed("u2", "SE3550000000054910000003");
  const first = await set({ account_ref: a, label: "Va​rdag" });
  assert.equal(first.label, "Vardag");
  assert.deepEqual(await set({ account_ref: b, label: "Vardag⁠" }), { error: "label_collision" });
  const rows = await db.allAccountsWithBank();
  assert.deepEqual(matchAccountUids(rows, "Var​dag"), ["u1"], "the account filter uses the same normalization");
});
