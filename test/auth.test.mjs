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
  assert.match(cookie, /SameSite=Lax/);
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
