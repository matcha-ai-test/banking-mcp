import assert from "node:assert/strict";
import test from "node:test";

import { authCookieHeader, createEnv, mockEnableBanking, request } from "./helpers.mjs";

// helpers.mjs registers the .ts resolver; import src after it, dynamically.
const { handleAuthCallback, handleAuthSession, handleAuthStart } = await import("../src/auth.ts");
const { Db } = await import("../src/db.ts");
const { matchAccountUids } = await import("../src/util.ts");

const CLOUD = "https://worker.example.test";
const LOCAL = "http://127.0.0.1:8787";

const PAYPAL_SE = { name: "PayPal", country: "SE", psu_types: ["personal"], maximum_consent_validity: 7776000 };
const PAYPAL_DE = { name: "PayPal", country: "DE", psu_types: ["personal"], maximum_consent_validity: 7776000 };
const AUTH_URL = "https://bank.example/authorize?x=1";

function aspspRoutes(list) {
  return {
    "GET /aspsps": (url) => {
      const country = url.searchParams.get("country");
      return { aspsps: country ? list.filter((a) => a.country === country) : list };
    },
  };
}

function withFetch(t, routes) {
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  return mock;
}

// ---------------------------------------------------------------- /auth/session

test("auth/session: wrong token gives 404 and no cookie", async () => {
  const env = await createEnv();
  const res = await handleAuthSession(request(`${CLOUD}/auth/session`, { method: "POST", body: { k: "wrong" } }), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("auth/session: right token over https sets a Secure, HttpOnly, /auth-scoped cookie", async () => {
  const env = await createEnv();
  const res = await handleAuthSession(
    request(`${CLOUD}/auth/session`, { method: "POST", body: { k: env.START_TOKEN } }),
    env
  );
  assert.equal(res.status, 204);
  const cookie = res.headers.get("Set-Cookie");
  assert.ok(cookie, "Set-Cookie present");
  assert.match(cookie, /^banking_auth=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/auth/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});

test("auth/session: over plain-http loopback the cookie is not Secure (Safari local mode)", async () => {
  const env = await createEnv();
  const res = await handleAuthSession(
    request(`${LOCAL}/auth/session`, { method: "POST", body: { k: env.START_TOKEN } }),
    env
  );
  assert.equal(res.status, 204);
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, /^banking_auth=/);
  assert.match(cookie, /HttpOnly/);
  assert.doesNotMatch(cookie, /Secure/);
});

test("auth/session: non-JSON body gives 404", async () => {
  const env = await createEnv();
  const res = await handleAuthSession(
    request(`${CLOUD}/auth/session`, { method: "POST", body: "k=test-start-token", headers: { "Content-Type": "text/plain" } }),
    env
  );
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("auth/session: GET gives 404", async () => {
  const env = await createEnv();
  const res = await handleAuthSession(request(`${CLOUD}/auth/session`), env);
  assert.equal(res.status, 404);
});

test("auth/session: the 11th failed attempt from one client in an hour is rate limited", async () => {
  const env = await createEnv();
  const ip = "203.0.113.7";
  for (let i = 1; i <= 10; i++) {
    const res = await handleAuthSession(request(`${CLOUD}/auth/session`, { method: "POST", body: { k: "wrong" }, ip }), env);
    assert.equal(res.status, 404, `attempt ${i}`);
  }
  const eleventh = await handleAuthSession(request(`${CLOUD}/auth/session`, { method: "POST", body: { k: "wrong" }, ip }), env);
  assert.equal(eleventh.status, 429);
  // Another client is unaffected.
  const other = await handleAuthSession(
    request(`${CLOUD}/auth/session`, { method: "POST", body: { k: "wrong" }, ip: "198.51.100.9" }),
    env
  );
  assert.equal(other.status, 404);
});

// ------------------------------------------------------------------ /auth/start

test("auth/start: without the cookie serves the gate page, even with ?bank", async () => {
  const env = await createEnv();
  const res = await handleAuthStart(request(`${CLOUD}/auth/start?bank=PayPal`), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Connect a bank/);
});

test("auth/start: with cookie but no ?bank gives 400 'No bank specified'", async () => {
  const env = await createEnv();
  const res = await handleAuthStart(request(`${CLOUD}/auth/start`, { headers: { Cookie: await authCookieHeader() } }), env);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /No bank specified/);
});

test("auth/start: a bank listed in several countries is refused without ?country", async (t) => {
  const env = await createEnv();
  withFetch(t, aspspRoutes([PAYPAL_SE, PAYPAL_DE]));
  const res = await handleAuthStart(
    request(`${CLOUD}/auth/start?bank=PayPal`, { headers: { Cookie: await authCookieHeader() } }),
    env
  );
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Bank exists in several countries/);
  assert.match(body, /SE/);
  assert.match(body, /DE/);
});

test("auth/start: bank + country redirects to Enable Banking and stores an auth state", async (t) => {
  const env = await createEnv();
  const mock = withFetch(t, { ...aspspRoutes([PAYPAL_SE, PAYPAL_DE]), "POST /auth": { url: AUTH_URL } });
  const res = await handleAuthStart(
    request(`${CLOUD}/auth/start?bank=PayPal&country=SE`, { headers: { Cookie: await authCookieHeader() } }),
    env
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), AUTH_URL);

  const states = env.DB.sqlite.prepare("SELECT state, psu_type, used_at FROM auth_state").all();
  assert.equal(states.length, 1);
  assert.equal(states[0].psu_type, "personal");
  assert.equal(states[0].used_at, null);

  const authCall = mock.calls.find((c) => c.method === "POST" && c.path === "/auth");
  assert.ok(authCall, "POST /auth was made");
  assert.equal(authCall.body.state, states[0].state);
  assert.equal(authCall.body.redirect_url, `${CLOUD}/auth/callback`);
  assert.deepEqual(authCall.body.aspsp, { name: "PayPal", country: "SE" });
});

test("auth/start: unknown bank gives 400 'Unknown bank'", async (t) => {
  const env = await createEnv();
  withFetch(t, aspspRoutes([PAYPAL_SE, PAYPAL_DE]));
  const res = await handleAuthStart(
    request(`${CLOUD}/auth/start?bank=Nonexistent&country=SE`, { headers: { Cookie: await authCookieHeader() } }),
    env
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Unknown bank/);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM auth_state").get().n, 0);
});

// --------------------------------------------------------------- /auth/callback

const OLD_SESSION = {
  id: "old-session-pk",
  session_id: "upstream-old",
  psu_type: "personal",
  valid_until: "2026-12-01T00:00:00Z",
  aspsp_name: "PayPal",
  aspsp_country: "SE",
};

function sessionsResponse(accounts) {
  return {
    session_id: "upstream-1",
    accounts,
    access: { valid_until: "2027-01-01T00:00:00Z" },
    aspsp: { name: "PayPal", country: "SE" },
  };
}

const ACC_1 = { uid: "acc-1", name: "PayPal wallet", account_id: { iban: "SE1234567890123456789012" }, currency: "SEK" };

async function seedActiveSession(env) {
  const db = new Db(env);
  await db.insertSession(OLD_SESSION);
  const state = crypto.randomUUID();
  await db.insertAuthState(state, "personal");
  return { db, state };
}

function sessionRows(env) {
  return env.DB.sqlite.prepare("SELECT id, status, session_id FROM eb_sessions ORDER BY created_at").all();
}

test("auth/callback: a re-auth that returns no accounts does not replace the working session", async (t) => {
  const env = await createEnv();
  const { state } = await seedActiveSession(env);
  const mock = withFetch(t, { "POST /sessions": sessionsResponse([]) });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Connected, but no accounts/);

  const rows = sessionRows(env);
  assert.equal(rows.length, 1, "no new eb_sessions row");
  assert.equal(rows[0].id, OLD_SESSION.id);
  assert.equal(rows[0].status, "active");
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM accounts").get().n, 0);
  // The state is single-use even on this path.
  const st = env.DB.sqlite.prepare("SELECT used_at FROM auth_state WHERE state = ?").get(state);
  assert.ok(st.used_at, "auth state consumed");
  // Only the session exchange was made; no account calls.
  assert.deepEqual(
    mock.calls.map((c) => `${c.method} ${c.path}`),
    ["POST /sessions"]
  );
});

test("auth/callback: a re-auth with accounts replaces the old session and stores the accounts", async (t) => {
  const env = await createEnv();
  const { state } = await seedActiveSession(env);
  const mock = withFetch(t, {
    "POST /sessions": sessionsResponse([ACC_1]),
    "GET /accounts/acc-1/balances": { balances: [] },
    "GET /accounts/acc-1/transactions": { transactions: [] },
  });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<h1>Connected<\/h1>/);
  assert.match(body, /PayPal \(personal\)/);
  assert.match(body, /2027-01-01/);
  // Full IBAN never appears on the page; only the masked tail.
  assert.doesNotMatch(body, /SE1234567890123456789012/);
  assert.match(body, /9012/);

  const rows = sessionRows(env);
  assert.equal(rows.length, 2);
  const old = rows.find((r) => r.id === OLD_SESSION.id);
  const fresh = rows.find((r) => r.id !== OLD_SESSION.id);
  assert.equal(old.status, "replaced");
  assert.equal(fresh.status, "active");
  assert.equal(fresh.session_id, "upstream-1");

  const accounts = env.DB.sqlite.prepare("SELECT account_uid, session_pk, name, iban, currency, psu_type FROM accounts").all();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].account_uid, "acc-1");
  assert.equal(accounts[0].session_pk, fresh.id);
  assert.equal(accounts[0].name, "PayPal wallet");
  assert.equal(accounts[0].iban, "SE1234567890123456789012");
  assert.equal(accounts[0].currency, "SEK");
  assert.equal(accounts[0].psu_type, "personal");

  assert.ok(mock.calls.some((c) => c.path === "/accounts/acc-1/transactions"), "backfill fetched transactions");
  assert.ok(mock.calls.some((c) => c.path === "/accounts/acc-1/balances"), "backfill fetched balances");
});

test("auth/callback: ?error=access_denied gives 400 'Authorization was canceled'", async () => {
  const env = await createEnv();
  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?error=access_denied`), env);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Authorization was canceled/);
});

test("auth/callback: missing state gives 400 'Invalid request'", async () => {
  const env = await createEnv();
  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc`), env);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Invalid request/);
});

// -------------------------------------------------------------- matchAccountUids

const ROWS = [
  {
    account_uid: "u1",
    session_pk: "s1",
    name: "Main",
    iban: "SE1234567890123456781234",
    currency: "SEK",
    psu_type: "personal",
    product: null,
    last_synced_at: null,
    aspsp_name: "SEB",
  },
  {
    account_uid: "u2",
    session_pk: "s2",
    name: "Wallet",
    iban: null,
    currency: "EUR",
    psu_type: "personal",
    product: null,
    last_synced_at: null,
    aspsp_name: "PayPal",
  },
];

test("matchAccountUids: blank filter means no filter", () => {
  assert.equal(matchAccountUids(ROWS, " "), null);
  assert.equal(matchAccountUids(ROWS, ""), null);
  assert.equal(matchAccountUids(ROWS, undefined), null);
});

test("matchAccountUids: last four IBAN digits match, plain or masked as list_accounts shows them", () => {
  assert.deepEqual(matchAccountUids(ROWS, "1234"), ["u1"]);
  assert.deepEqual(matchAccountUids(ROWS, "•••• 1234"), ["u1"]);
});

test("matchAccountUids: arbitrary IBAN substrings do not match (no reconstruction oracle)", () => {
  assert.deepEqual(matchAccountUids(ROWS, "SE12"), []);
  assert.deepEqual(matchAccountUids(ROWS, "SE123456789012345678"), []);
});

test("matchAccountUids: the full IBAN matches, spaces ignored", () => {
  assert.deepEqual(matchAccountUids(ROWS, "SE12 3456 7890 1234 5678 1234"), ["u1"]);
});

test("matchAccountUids: name (case-insensitive substring), bank name and uid match", () => {
  assert.deepEqual(matchAccountUids(ROWS, "wallet"), ["u2"]);
  assert.deepEqual(matchAccountUids(ROWS, "paypal"), ["u2"]);
  assert.deepEqual(matchAccountUids(ROWS, "u2"), ["u2"]);
});

const ROWS_WITH_LABELS = [
  { ...ROWS[0], label: "Vardagskonto", account_identity_id: "a".repeat(32) },
  { ...ROWS[1], label: null, account_identity_id: null },
];

test("matchAccountUids: label matches by case-insensitive exact equality, not substring", () => {
  assert.deepEqual(matchAccountUids(ROWS_WITH_LABELS, "vardagskonto"), ["u1"]);
  assert.deepEqual(matchAccountUids(ROWS_WITH_LABELS, "vardag"), []);
});

test("matchAccountUids: the opaque account_ref (32 hex chars) matches exactly", () => {
  assert.deepEqual(matchAccountUids(ROWS_WITH_LABELS, "a".repeat(32)), ["u1"]);
  // A 32-hex-looking value that does not belong to any row matches nothing.
  assert.deepEqual(matchAccountUids(ROWS_WITH_LABELS, "b".repeat(32)), []);
});

// ------------------------------------------------------------------------- G1

test("matchAccountUids: an exact label or account_ref hit takes precedence over a same-string name/bank substring match on an unrelated account", () => {
  const rows = [
    { ...ROWS[0], account_uid: "credit", name: "Credit Card", label: null, account_identity_id: null },
    { ...ROWS[1], account_uid: "labelled", name: "Konto", label: "card", account_identity_id: "b".repeat(32) },
  ];
  // "card" is a substring of A's name AND an exact label on B: only B wins.
  assert.deepEqual(matchAccountUids(rows, "card"), ["labelled"]);
  // The account_ref is exact too: only the row(s) sharing that identity.
  assert.deepEqual(matchAccountUids(rows, "b".repeat(32)), ["labelled"]);
  // A filter that is no label still falls back to name-substring matching.
  assert.deepEqual(matchAccountUids(rows, "credit"), ["credit"]);
});

// ------------------------------------------------------- Step 0: re-auth continuity (0.I #8, #9)

test("auth/callback re-auth: the surviving uid keeps resolving through a label set on the prior generation's identity", async (t) => {
  const env = await createEnv();
  const { db, state } = await seedActiveSession(env);
  // Seed an old generation under the OLD_SESSION and give it a stable identity + label,
  // the way a real prior auth/backfill would have (Step 0 spine, Step 1 label).
  await db.upsertAccounts([{
    account_uid: "acc-0", session_pk: OLD_SESSION.id, name: "PayPal wallet",
    iban: ACC_1.account_id.iban, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null,
  }]);
  const { assignAccountIdentities } = await import("../src/identity.ts");
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows);
  const identityId = await db.accountIdentityOf("acc-0");
  assert.ok(identityId);
  await db.upsertLabel(identityId, "Buffert", null);

  const mock = withFetch(t, {
    "POST /sessions": sessionsResponse([ACC_1]),
    "GET /accounts/acc-1/balances": { balances: [] },
    "GET /accounts/acc-1/transactions": { transactions: [] },
  });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);

  // The old generation was folded away; the new uid carries the same identity and label.
  const accounts = env.DB.sqlite.prepare("SELECT account_uid FROM accounts").all();
  assert.deepEqual(accounts.map((a) => a.account_uid), ["acc-1"]);
  assert.equal(await db.accountIdentityOf("acc-1"), identityId);
  const rowsWithBank = await db.allAccountsWithBank();
  assert.equal(rowsWithBank.find((r) => r.account_uid === "acc-1").label, "Buffert");
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM account_identities").get().n, 1);
  assert.ok(mock.calls.some((c) => c.path === "/accounts/acc-1/transactions"));
});

test("auth/callback: a transient_error from identity assignment skips the fold for that account, exactly like identity_conflict", async (t) => {
  const env = await createEnv();
  const { db, state } = await seedActiveSession(env);
  await db.upsertAccounts([{
    account_uid: "acc-0", session_pk: OLD_SESSION.id, name: "PayPal wallet",
    iban: ACC_1.account_id.iban, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null,
  }]);

  const original = Db.prototype.identityByIban;
  Db.prototype.identityByIban = async function (iban, currency, psuType) {
    if (iban === ACC_1.account_id.iban) throw new Error("simulated transient failure");
    return original.call(this, iban, currency, psuType);
  };
  t.after(() => { Db.prototype.identityByIban = original; });

  withFetch(t, {
    "POST /sessions": sessionsResponse([ACC_1]),
    "GET /accounts/acc-1/balances": { balances: [] },
    "GET /accounts/acc-1/transactions": { transactions: [] },
  });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);

  // Fold was skipped: both the old and the new generation still exist.
  const accounts = env.DB.sqlite.prepare("SELECT account_uid FROM accounts").all();
  assert.deepEqual(accounts.map((a) => a.account_uid).sort(), ["acc-0", "acc-1"]);
});

test("auth/callback: a session account with identification_hash but no IBAN persists the hash on both accounts and account_identities with zero extra bank calls", async (t) => {
  const env = await createEnv();
  const { state } = await seedActiveSession(env);
  const accWithHash = { uid: "acc-hash", name: "Hash wallet", account_id: { iban: null }, identification_hash: "hash-abc", currency: "SEK" };
  const mock = withFetch(t, {
    "POST /sessions": sessionsResponse([accWithHash]),
    "GET /accounts/acc-hash/balances": { balances: [] },
    "GET /accounts/acc-hash/transactions": { transactions: [] },
  });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);

  const accountRow = env.DB.sqlite.prepare("SELECT identification_hash, account_identity_id FROM accounts WHERE account_uid = 'acc-hash'").get();
  assert.equal(accountRow.identification_hash, "hash-abc");
  assert.ok(accountRow.account_identity_id);
  const identityRow = env.DB.sqlite.prepare("SELECT identification_hash FROM account_identities WHERE id = ?").get(accountRow.account_identity_id);
  assert.equal(identityRow.identification_hash, "hash-abc");

  // Only the session exchange and the two backfill calls were made; no separate identity-related bank call.
  assert.deepEqual(
    mock.calls.map((c) => `${c.method} ${c.path}`).sort(),
    ["GET /accounts/acc-hash/balances", "GET /accounts/acc-hash/transactions", "POST /sessions"].sort()
  );
});

test("auth/callback: identification_hash mapping — singular wins over the array; a single-distinct-value array is used as fallback; a two-distinct-value array is ambiguous and dropped", async (t) => {
  const env = await createEnv();
  const { state } = await seedActiveSession(env);
  const accSingularWins = {
    uid: "acc-singular", name: "Singular wins", account_id: { iban: null },
    identification_hash: "hash-singular", identification_hashes: ["hash-from-array"], currency: "SEK",
  };
  const accArrayOneDistinct = {
    uid: "acc-arr-one", name: "Array one distinct", account_id: { iban: null },
    identification_hashes: ["hash-arr", "hash-arr"], currency: "SEK",
  };
  const accArrayTwoDistinct = {
    uid: "acc-arr-two", name: "Array two distinct", account_id: { iban: null },
    identification_hashes: ["hash-a", "hash-b"], currency: "SEK",
  };
  withFetch(t, {
    "POST /sessions": sessionsResponse([accSingularWins, accArrayOneDistinct, accArrayTwoDistinct]),
    "GET /accounts/acc-singular/balances": { balances: [] },
    "GET /accounts/acc-singular/transactions": { transactions: [] },
    "GET /accounts/acc-arr-one/balances": { balances: [] },
    "GET /accounts/acc-arr-one/transactions": { transactions: [] },
    "GET /accounts/acc-arr-two/balances": { balances: [] },
    "GET /accounts/acc-arr-two/transactions": { transactions: [] },
  });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);

  const rowFor = (uid) => env.DB.sqlite.prepare("SELECT identification_hash, account_identity_id FROM accounts WHERE account_uid = ?").get(uid);

  const singular = rowFor("acc-singular");
  assert.equal(singular.identification_hash, "hash-singular");
  assert.ok(singular.account_identity_id);

  const arrOne = rowFor("acc-arr-one");
  assert.equal(arrOne.identification_hash, "hash-arr");
  assert.ok(arrOne.account_identity_id);

  const arrTwo = rowFor("acc-arr-two");
  assert.equal(arrTwo.identification_hash, null);
  // With neither an IBAN nor a usable hash, no stable identity could be assigned.
  assert.equal(arrTwo.account_identity_id, null);
});

test("auth/callback: an identification_hash over 2048 chars is dropped rather than persisted", async (t) => {
  const env = await createEnv();
  const { state } = await seedActiveSession(env);
  const accWithTooLongHash = {
    uid: "acc-toolong", name: "Too-long wallet", account_id: { iban: null },
    identification_hash: "h".repeat(2049), currency: "SEK",
  };
  withFetch(t, {
    "POST /sessions": sessionsResponse([accWithTooLongHash]),
    "GET /accounts/acc-toolong/balances": { balances: [] },
    "GET /accounts/acc-toolong/transactions": { transactions: [] },
  });

  const res = await handleAuthCallback(request(`${CLOUD}/auth/callback?code=abc&state=${state}`), env);
  assert.equal(res.status, 200);

  const accountRow = env.DB.sqlite
    .prepare("SELECT identification_hash, account_identity_id FROM accounts WHERE account_uid = 'acc-toolong'")
    .get();
  assert.equal(accountRow.identification_hash, null);
  assert.equal(accountRow.account_identity_id, null);
});
