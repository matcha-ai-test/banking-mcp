import assert from "node:assert/strict";
import test from "node:test";
import { createEnv, mockEnableBanking } from "./helpers.mjs";

const { Db } = await import("../src/db.ts");
const { EbClient } = await import("../src/eb.ts");
const { readAuthStatus, LIVE_VERIFY_COOLDOWN_MS } = await import("../src/auth-status.ts");
const NOW = Date.parse("2030-01-01T12:00:00Z");
const LIVE = { status: "AUTHORIZED", access: { valid_until: "2030-06-01T00:00:00Z" } };

async function setup(t, routes = {}, count = 1) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const db = new Db(env);
  for (let i = 0; i < count; i++) {
    await db.insertSession({ id: `local-${i}`, session_id: `upstream-${i}`, psu_type: "personal",
      aspsp_name: "Example Bank", aspsp_country: "SE", valid_until: "2030-05-01T00:00:00Z" });
  }
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  return { env, db, mock, read: (verify, now = NOW) => readAuthStatus(db, () => new EbClient(env), verify, now) };
}

test("omitted or false verify preserves cached output and never constructs an API client", async (t) => {
  const { db, env, mock } = await setup(t, {}, 11);
  const before = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all();
  for (const verify of [undefined, false]) {
    const result = await readAuthStatus(db, () => { throw new Error("must not construct"); }, verify, NOW);
    assert.deepEqual(result, { sessions: await db.allSessions(10) });
    assert.equal(result.sessions.length, 10);
  }
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(env.DB.sqlite.prepare("SELECT * FROM eb_sessions").all(), before);
});

test("verification persists allowlisted results, hides identifiers, and reuses them until 15 minutes", async (t) => {
  const { read, env, mock } = await setup(t, { "GET /sessions/upstream-0": { ...LIVE, accounts: ["hidden-account"] } });
  const first = await read(true);
  assert.deepEqual(first.liveResults, [{ live_status: LIVE.status, live_valid_until: LIVE.access.valid_until, live_error: null, live_verified_at: new Date(NOW).toISOString(), live_cached: false }]);
  const row = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").get();
  assert.equal(row.live_verify_claimed_at, new Date(NOW).toISOString());
  assert.deepEqual(JSON.parse(row.live_verify_result), { live_status: LIVE.status, live_valid_until: LIVE.access.valid_until, live_error: null });
  assert.equal(row.status, "active");
  assert.equal(row.valid_until, "2030-05-01T00:00:00Z");
  assert.equal(row.refresh_count_today, 0);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM sync_log").get().n, 0);
  assert.equal(/local-0|upstream-0|hidden-account/.test(JSON.stringify(first)), false);
  const cached = await read(true, NOW + LIVE_VERIFY_COOLDOWN_MS - 1);
  assert.deepEqual(cached.liveResults, [{ ...first.liveResults[0], live_cached: true }]);
  assert.equal(mock.calls.length, 1);
  assert.equal((await read(true, NOW + LIVE_VERIFY_COOLDOWN_MS)).liveResults[0].live_cached, false);
  assert.equal(mock.calls.length, 2);
});

for (const timestamp of ["2030-01-01 11:59:00", "2030-01-01T11:59:00Z", "2030-01-01T12:59:00+01:00"]) {
  test(`sync evidence never claims verification cooldown: ${timestamp}`, async (t) => {
    const { env, read, mock } = await setup(t, { "GET /sessions/upstream-0": LIVE });
    env.DB.sqlite.prepare("UPDATE eb_sessions SET last_live_verified_at = ?, last_live_result = 'ok'").run(timestamp);
    const result = await read(true);
    assert.equal(result.liveResults[0].live_cached, false);
    assert.equal(result.sessions[0].last_live_verified_at, timestamp);
    assert.equal(result.sessions[0].last_live_result, "ok");
    assert.equal(mock.calls.length, 1);
  });
}

for (const [body, status, expected] of [
  ["EXPIRED_SESSION sensitive-upstream-body", 400, "expired_session"],
  ["sensitive-upstream-body", 429, "rate_limited"],
  ["sensitive-upstream-body", 403, "session_verification_failed"],
  ["sensitive-upstream-body", 503, "session_verification_failed"],
]) {
  test(`failure ${status} is sanitized, persisted and cooled down without stopping other sessions`, async (t) => {
    const { read, mock, env } = await setup(t, {
      "GET /sessions/upstream-0": () => new Response(body, { status }),
      "GET /sessions/upstream-1": LIVE,
    }, 2);
    const first = await read(true);
    assert.equal(first.liveResults[0].live_error, expected);
    assert.equal(first.liveResults[1].live_status, LIVE.status);
    assert.equal(JSON.stringify(first).includes("sensitive-upstream-body"), false);
    assert.equal(env.DB.sqlite.prepare("SELECT live_verify_result FROM eb_sessions WHERE id = 'local-0'").get().live_verify_result.includes("sensitive-upstream-body"), false);
    const cached = await read(true, NOW + 1000);
    assert.equal(cached.liveResults[0].live_error, expected);
    assert.ok(cached.liveResults.every((r) => r.live_cached));
    assert.equal(mock.calls.length, 2);
  });
}

test("two simultaneous cold claims start before HTTP and only one reaches the bank", async (t) => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const { read, mock, db } = await setup(t, { "GET /sessions/upstream-0": async () => { started(); await gate; return LIVE; } });
  const list = db.sessionsForVerification.bind(db);
  let snapshots = 0;
  let releaseSnapshots;
  const bothCold = new Promise((resolve) => { releaseSnapshots = resolve; });
  db.sessionsForVerification = async (id) => {
    const rows = await list(id);
    if (id === undefined) {
      assert.equal(rows[0].live_verify_claimed_at ?? null, null);
      snapshots++;
      if (snapshots === 2) {
        assert.equal(mock.calls.length, 0);
        releaseSnapshots();
      }
      await bothCold;
    }
    return rows;
  };
  const first = read(true);
  const secondPromise = read(true);
  await entered;
  const second = await secondPromise;
  assert.equal(second.liveResults[0].live_cached, true);
  assert.equal(second.liveResults[0].live_error, "verification_in_progress");
  release();
  assert.equal((await first).liveResults[0].live_cached, false);
  assert.equal(mock.calls.length, 1);
});

test("verify includes all stored sessions, including inactive sessions beyond the cached limit", async (t) => {
  const routes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`GET /sessions/upstream-${i}`, LIVE]));
  const { read, env, mock } = await setup(t, routes, 12);
  env.DB.sqlite.prepare("UPDATE eb_sessions SET status = 'replaced' WHERE id = 'local-11'").run();
  const result = await read(true);
  assert.equal(result.sessions.length, 12);
  assert.equal(mock.calls.length, 12);
  assert.ok(result.sessions.some((s) => s.status === "replaced"));
});

test("empty session store does not construct a client", async (t) => {
  const { db } = await setup(t, {}, 0);
  assert.deepEqual(await readAuthStatus(db, () => { throw new Error("must not construct"); }, true), { sessions: [], liveResults: [] });
});

test("sync between claim and completion preserves both independent evidence sets", async (t) => {
  const { db, env, read } = await setup(t, {
    "GET /sessions/upstream-0": async () => {
      const before = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").get();
      assert.equal(before.last_live_result, null);
      assert.equal(before.last_live_verified_at, null);
      await db.setSessionLiveOk("local-0");
      const after = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").get();
      assert.equal(after.live_verify_result, before.live_verify_result);
      assert.equal(after.live_verify_claimed_at, before.live_verify_claimed_at);
      return LIVE;
    },
  });
  const result = await read(true);
  assert.equal(result.sessions[0].last_live_result, "ok");
  assert.equal(result.sessions[0].last_live_verified_at,
    env.DB.sqlite.prepare("SELECT last_live_verified_at FROM eb_sessions").get().last_live_verified_at);
  const before = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").get();
  await db.setSessionExpired("local-0");
  const after = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").get();
  assert.equal(after.live_verify_claimed_at, before.live_verify_claimed_at);
  assert.equal(after.live_verify_result, before.live_verify_result);
  assert.equal((await read(true, NOW + 899_100)).liveResults[0].live_cached, true);
});

test("response rereads persisted state when completion loses its claim guard", async (t) => {
  const winnerAt = new Date(NOW + LIVE_VERIFY_COOLDOWN_MS).toISOString();
  const winner = { live_status: "EXPIRED", live_valid_until: null, live_error: null };
  const { env, read } = await setup(t, {
    "GET /sessions/upstream-0": () => {
      env.DB.sqlite.prepare("UPDATE eb_sessions SET live_verify_claimed_at = ?, live_verify_result = ?")
        .run(winnerAt, JSON.stringify(winner));
      return LIVE;
    },
  });
  assert.deepEqual((await read(true)).liveResults[0], {
    ...winner, live_cached: false, live_verified_at: winnerAt,
  });
});

test("all sessions use the same request clock and cutoff despite a delayed first response", async (t) => {
  const { db, env, mock } = await setup(t, { "GET /sessions/upstream-0": LIVE }, 2);
  // Second session is just inside the cooldown at request start.
  const recent = new Date(NOW - LIVE_VERIFY_COOLDOWN_MS + 1).toISOString();
  env.DB.sqlite.prepare("UPDATE eb_sessions SET live_verify_claimed_at = ? WHERE id = 'local-1'").run(recent);
  const clock = Date.now;
  Date.now = () => NOW;
  t.after(() => { Date.now = clock; });
  const claims = [];
  const claim = db.claimSessionVerification.bind(db);
  db.claimSessionVerification = (...args) => { claims.push(args); return claim(...args); };
  const result = await readAuthStatus(db, () => ({ getSession: async (id) => {
    const response = await new EbClient(env).getSession(id);
    Date.now = () => NOW + 60_000;
    return response;
  } }), true);
  assert.equal(mock.calls.length, 1);
  assert.equal(result.liveResults[1].live_cached, true);
  assert.deepEqual(claims.map((args) => args.slice(1, 3)), Array(2).fill([
    new Date(NOW).toISOString(), new Date(NOW - LIVE_VERIFY_COOLDOWN_MS).toISOString(),
  ]));
});
