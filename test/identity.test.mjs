// Step 0: shared stable identity registry. Every test here runs under
// mockEnableBanking({}) (zero bank calls) except the two auth/callback tests,
// which are covered separately in test/auth.test.mjs (spec 0.I item 10).

import assert from "node:assert/strict";
import test from "node:test";
import { createEnv, mockEnableBanking } from "./helpers.mjs";

const { Db } = await import("../src/db.ts");
const {
  canonicalIban,
  canonicalCurrency,
  assignAccountIdentities,
  resolveAccountIdentity,
  backfillAccountIdentities,
  naturalIdentityOf,
} = await import("../src/identity.ts");
const { initializeStorage, ensureIdentityBackfill, __resetIdentityBackfillForTests, __resetStorageInitForTests } = await import("../src/bootstrap.ts");

async function setup(t) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const mock = mockEnableBanking({});
  t.after(() => mock.restore());
  return new Db(env);
}

test("canonicalIban strips spaces and uppercases; rejects out-of-range lengths and punctuation", () => {
  assert.equal(canonicalIban("se12 3456 7890 1234 5678 1234"), "SE1234567890123456781234");
  assert.equal(canonicalIban("SE12"), null); // 4 chars
  assert.equal(canonicalIban("A".repeat(35)), null); // 35 chars
  assert.equal(canonicalIban("SE12-3456"), null); // punctuation
  assert.equal(canonicalIban(null), null);
  assert.equal(canonicalIban(undefined), null);
});

test("canonicalCurrency uppercases and normalizes unknown to empty string", () => {
  assert.equal(canonicalCurrency("sek"), "SEK");
  assert.equal(canonicalCurrency(null), "");
  assert.equal(canonicalCurrency("12"), "");
  assert.equal(canonicalCurrency(" eur "), "EUR");
});

test("same IBAN + currency + psu_type resolves to one id across two calls; created flag true then false", async (t) => {
  const db = await setup(t);
  const n = { iban: "SE1234567890", identificationHash: null, currency: "SEK", psuType: "personal" };
  const first = await resolveAccountIdentity(db, n);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  const second = await resolveAccountIdentity(db, n);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
});

test("same IBAN, different currency or psu_type, produces distinct ids", async (t) => {
  const db = await setup(t);
  const base = { iban: "SE1234567890", identificationHash: null, currency: "SEK", psuType: "personal" };
  const a = await resolveAccountIdentity(db, base);
  const byCurrency = await resolveAccountIdentity(db, { ...base, currency: "EUR" });
  const byPsu = await resolveAccountIdentity(db, { ...base, psuType: "business" });
  assert.notEqual(byCurrency.id, a.id);
  assert.notEqual(byPsu.id, a.id);
  assert.notEqual(byCurrency.id, byPsu.id);
});

test("hash-only first, IBAN + same hash second: fails closed as identity_conflict, no pointer attached", async (t) => {
  const db = await setup(t);
  const hashOnly = { iban: null, identificationHash: "hash-1", currency: "SEK", psuType: "personal" };
  const first = await resolveAccountIdentity(db, hashOnly);
  assert.equal(first.ok, true);

  const withIban = { iban: "SE1234567890", identificationHash: "hash-1", currency: "SEK", psuType: "personal" };
  const second = await resolveAccountIdentity(db, withIban);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "identity_conflict");
  const row = await db.identityById(first.id);
  assert.equal(row.iban, null);

  // A fresh IBAN-only row for the same IBAN is unaffected: it creates its own identity.
  const ibanOnly = { iban: "SE1234567890", identificationHash: null, currency: "SEK", psuType: "personal" };
  const third = await resolveAccountIdentity(db, ibanOnly);
  assert.equal(third.ok, true);
  assert.notEqual(third.id, first.id);
});

test("IBAN wins: identity A (IBAN X), hash-only identity B (hash H); a row with IBAN X and hash H resolves to A, both rows unchanged", async (t) => {
  const db = await setup(t);
  const a = await resolveAccountIdentity(db, { iban: "SEXCONFLICT01", identificationHash: null, currency: "SEK", psuType: "personal" });
  const b = await resolveAccountIdentity(db, { iban: null, identificationHash: "H", currency: "SEK", psuType: "personal" });
  assert.notEqual(a.id, b.id);

  const resolved = await resolveAccountIdentity(db, { iban: "SEXCONFLICT01", identificationHash: "H", currency: "SEK", psuType: "personal" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.id, a.id);

  const rowA = await db.identityById(a.id);
  const rowB = await db.identityById(b.id);
  assert.equal(rowA.identification_hash, null);
  assert.equal(rowB.iban, null);
});

test("concurrent creators for the same natural identity converge on one id", async (t) => {
  const db = await setup(t);
  const n = { iban: "SECONCURRENT1", identificationHash: null, currency: "SEK", psuType: "personal" };
  const [a, b] = await Promise.all([resolveAccountIdentity(db, n), resolveAccountIdentity(db, n)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.id, b.id);
  // Exactly one of them created the row.
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
});

test("backfillAccountIdentities assigns two generations sharing an IBAN to one id, and is idempotent", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await db.upsertAccounts([
    { account_uid: "gen1", session_pk: "s", name: "Old", iban: "SEBACKFILL123", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "gen2", session_pk: "s", name: "New", iban: "SEBACKFILL123", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  const first = await backfillAccountIdentities(db);
  assert.equal(first.assigned, 2);
  assert.equal(first.conflicts, 0);
  const id1 = await db.accountIdentityOf("gen1");
  const id2 = await db.accountIdentityOf("gen2");
  assert.equal(id1, id2);
  assert.ok(id1);

  const second = await backfillAccountIdentities(db);
  assert.equal(second.assigned, 0);
  const count = await db.identityById(id1);
  assert.ok(count);
});

test("assignAccountIdentities reports stable_identity_unavailable for an account with neither IBAN nor hash", async (t) => {
  // accountsWithoutIdentity() (and therefore backfillAccountIdentities) deliberately
  // excludes bare rows from its SELECT (spec 0.F), so this exercises assignAccountIdentities
  // directly, the same call auth.ts makes on every account row from a session response.
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const bare = { account_uid: "bare", session_pk: "s", name: "Bare", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null };
  await db.upsertAccounts([bare]);
  const results = await assignAccountIdentities(db, [bare]);
  const res = results.get("bare");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stable_identity_unavailable");
  assert.equal(await db.accountIdentityOf("bare"), null);
});

// ------------------------------------------------------------------------- F1

test("naturalIdentityOf: an identification_hash longer than 2048 chars is treated as null", () => {
  const okHash = "h".repeat(2048);
  const tooLong = "h".repeat(2049);
  const withOk = naturalIdentityOf({ iban: null, identification_hash: okHash, currency: "SEK", psu_type: "personal" });
  assert.equal(withOk.identificationHash, okHash);
  const withTooLong = naturalIdentityOf({ iban: null, identification_hash: tooLong, currency: "SEK", psu_type: "personal" });
  assert.equal(withTooLong, null); // no IBAN either, so the whole natural identity is unavailable
  const ibanPlusTooLong = naturalIdentityOf({ iban: "SE1234567890", identification_hash: tooLong, currency: "SEK", psu_type: "personal" });
  assert.equal(ibanPlusTooLong.identificationHash, null);
});

// ------------------------------------------------------------------------- F2

test("assignAccountIdentities: a thrown error resolving one row is caught as transient_error (not identity_conflict) and the next row is still processed", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const rows = [
    { account_uid: "ok1", session_pk: "s", name: "OK1", iban: "SEOK0000001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "bad", session_pk: "s", name: "Bad", iban: "SEBAD000001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "ok2", session_pk: "s", name: "OK2", iban: "SEOK0000002", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ];
  await db.upsertAccounts(rows);
  const original = db.identityByIban.bind(db);
  db.identityByIban = async (iban, currency, psuType) => {
    if (iban === "SEBAD000001") throw new Error("simulated failure");
    return original(iban, currency, psuType);
  };
  t.after(() => { db.identityByIban = original; });

  const results = await assignAccountIdentities(db, rows);
  assert.equal(results.get("ok1").ok, true);
  assert.equal(results.get("bad").ok, false);
  assert.equal(results.get("bad").reason, "transient_error");
  assert.equal(results.get("ok2").ok, true);
});

test("initializeStorage: a backfillAccountIdentities failure is caught and never rejects initializeStorage", async (t) => {
  __resetIdentityBackfillForTests();
  t.after(() => __resetIdentityBackfillForTests());
  const env = await createEnv();
  t.after(() => env.DB.close());
  const original = Db.prototype.accountsWithoutIdentity;
  Db.prototype.accountsWithoutIdentity = async () => { throw new Error("simulated failure"); };
  t.after(() => { Db.prototype.accountsWithoutIdentity = original; });

  await assert.doesNotReject(() => initializeStorage(env));
});

test("initializeStorage: a migrate failure still propagates", async (t) => {
  __resetIdentityBackfillForTests();
  __resetStorageInitForTests();
  t.after(() => __resetStorageInitForTests());
  const brokenEnv = { DB: { prepare: () => { throw new Error("db unavailable"); } } };
  await assert.rejects(() => initializeStorage(brokenEnv));
});

test("initializeStorage: migration runs once per isolate, and a failed run is retried", async (t) => {
  __resetStorageInitForTests();
  t.after(() => __resetStorageInitForTests());
  let prepares = 0;
  let fail = true;
  const counting = { prepare: () => { prepares++; if (fail) throw new Error("db unavailable"); return { run: async () => ({}), all: async () => ({ results: [] }), first: async () => null, bind() { return this; } }; }, batch: async () => [] };
  const { ensureMigrated } = await import("../src/bootstrap.ts");
  await assert.rejects(() => ensureMigrated({ DB: counting }));
  fail = false;
  await ensureMigrated({ DB: counting });
  const afterFirstSuccess = prepares;
  assert.ok(afterFirstSuccess > 1, "the failed run is forgotten, so the second call really migrates");
  await ensureMigrated({ DB: counting });
  await ensureMigrated({ DB: counting });
  assert.equal(prepares, afterFirstSuccess, "later calls reuse the memo");
});

// ------------------------------------------------------------------------- G4 / J3

test("bootstrap: a backfill run with thrown errors is not memoized (retries on the very next call, not throttled); a run with errors > 0 is likewise not memoized", async (t) => {
  __resetIdentityBackfillForTests();
  t.after(() => __resetIdentityBackfillForTests());
  const env = await createEnv();
  t.after(() => env.DB.close());
  const realDb = new Db(env);
  await realDb.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await realDb.upsertAccounts([
    { account_uid: "u1", session_pk: "s", name: "A", iban: "SERETRY0001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);

  const originalInsert = Db.prototype.insertIdentityIgnore;
  let failNext = true;
  Db.prototype.insertIdentityIgnore = async function (...args) {
    if (failNext) {
      failNext = false;
      throw new Error("simulated transient failure");
    }
    return originalInsert.apply(this, args);
  };
  t.after(() => { Db.prototype.insertIdentityIgnore = originalInsert; });

  // First call: migrate + backfill attempt throws for u1 -> not memoized (errors > 0).
  await initializeStorage(env);
  assert.equal(await realDb.accountIdentityOf("u1"), null);

  // Second call, immediately after (no time advance): still retries because the
  // first run was not memoized, and this time succeeds -> memoized.
  await ensureIdentityBackfill(env);
  assert.ok(await realDb.accountIdentityOf("u1"));
});

test("J3: ensureIdentityBackfill throttles to once per 5 minutes per isolate — a call within the window does no DB work; a call after 5 minutes runs again", async (t) => {
  __resetIdentityBackfillForTests();
  t.after(() => __resetIdentityBackfillForTests());
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  const env = await createEnv();
  t.after(() => env.DB.close());
  const realDb = new Db(env);
  await realDb.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await realDb.upsertAccounts([
    { account_uid: "u1", session_pk: "s", name: "A", iban: "SETHROTTLE01", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);

  // First call: a clean successful run -> memoized.
  await ensureIdentityBackfill(env);
  assert.ok(await realDb.accountIdentityOf("u1"));

  // Second call, within the 5-minute window: throttled, no DB work at all.
  let called = false;
  const originalAwi = Db.prototype.accountsWithoutIdentity;
  Db.prototype.accountsWithoutIdentity = async function (...args) {
    called = true;
    return originalAwi.apply(this, args);
  };
  t.after(() => { Db.prototype.accountsWithoutIdentity = originalAwi; });
  t.mock.timers.tick(4 * 60_000); // +4 minutes, still inside the window
  await ensureIdentityBackfill(env);
  assert.equal(called, false);

  // Advance past 5 minutes total: throttle window has elapsed, runs again.
  t.mock.timers.tick(2 * 60_000); // +2 more minutes = +6 minutes total
  await ensureIdentityBackfill(env);
  assert.equal(called, true);
});

// ------------------------------------------------------------------------- F3

test("resolveAccountIdentity: IBAN is authoritative — hash-only first, then IBAN+same hash second, fails closed as identity_conflict (no attach)", async (t) => {
  const db = await setup(t);
  const hashOnly = { iban: null, identificationHash: "hash-concurrent", currency: "SEK", psuType: "personal" };
  const created = await resolveAccountIdentity(db, hashOnly);
  assert.equal(created.ok, true);

  const n = { iban: "SECONCURRENT99", identificationHash: "hash-concurrent", currency: "SEK", psuType: "personal" };
  const result = await resolveAccountIdentity(db, n);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "identity_conflict");

  // Both orders give identity_conflict for the second row: IBAN+hash first,
  // then hash-only (already covered by the H4 test below); here the reverse
  // order is checked, and the hash-only identity is left untouched.
  const row = await db.identityById(created.id);
  assert.equal(row.iban, null);
  assert.equal(row.identification_hash, "hash-concurrent");
});

test("resolveAccountIdentity: a concurrent attach of the same hash value between lookup and attach counts as success", async (t) => {
  const db = await setup(t);
  const ibanOnly = { iban: "SEHASHATTACH1", identificationHash: null, currency: "SEK", psuType: "personal" };
  const created = await resolveAccountIdentity(db, ibanOnly);
  assert.equal(created.ok, true);

  // Simulate a concurrent writer: our own attachIdentityHash call actually
  // writes the value (as a real concurrent winner would have), but reports
  // failure the way the real D1 method does when its WHERE clause no longer
  // matches (identification_hash IS NULL) after someone else already attached it.
  const original = db.attachIdentityHash.bind(db);
  let intercepted = false;
  db.attachIdentityHash = async (id, hash) => {
    if (!intercepted) {
      intercepted = true;
      await original(id, hash);
      return false;
    }
    return original(id, hash);
  };
  t.after(() => { db.attachIdentityHash = original; });

  const n = { iban: "SEHASHATTACH1", identificationHash: "hash-attach", currency: "SEK", psuType: "personal" };
  const result = await resolveAccountIdentity(db, n);
  assert.equal(result.ok, true);
  assert.equal(result.id, created.id);
});

test("resolveAccountIdentity: a lost hash attach after an IBAN match still resolves to the IBAN identity", async (t) => {
  const db = await setup(t);
  const ibanOnly = { iban: "SEHASHATTACH2", identificationHash: null, currency: "SEK", psuType: "personal" };
  const created = await resolveAccountIdentity(db, ibanOnly);
  assert.equal(created.ok, true);

  const original = db.attachIdentityHash.bind(db);
  db.attachIdentityHash = async (id, _hash) => {
    // A concurrent writer attached a DIFFERENT hash first.
    await original(id, "hash-other-writer");
    return false;
  };
  t.after(() => { db.attachIdentityHash = original; });

  const n = { iban: "SEHASHATTACH2", identificationHash: "hash-mine", currency: "SEK", psuType: "personal" };
  const result = await resolveAccountIdentity(db, n);
  assert.equal(result.ok, true);
  assert.equal(result.id, created.id);
  assert.equal((await db.identityById(created.id)).identification_hash, "hash-other-writer");
});

test("a hash that points at an identity with a different IBAN is still a conflict", async (t) => {
  const db = await setup(t);
  const x = await resolveAccountIdentity(db, { iban: "SEXIBANONE001", identificationHash: "HX", currency: "SEK", psuType: "personal" });
  const res = await resolveAccountIdentity(db, { iban: "SEYIBANTWO002", identificationHash: "HX", currency: "SEK", psuType: "personal" });
  assert.equal(x.ok, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "identity_conflict");
});

test("fold gate: an uncanonicalizable IBAN still counts as having an IBAN, symmetrically", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const idRes = await resolveAccountIdentity(db, { iban: null, identificationHash: "HG", currency: "SEK", psuType: "personal" });
  await db.upsertAccounts([{ account_uid: "nulliban", session_pk: "s", name: "A", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "HG" }]);
  await db.setAccountIdentityIfNull("nulliban", idRes.id);
  // Keeper has a non-canonical IBAN (hyphens): the IBAN-less candidate must not be folded into it.
  const stale = await db.staleAccountGenerations("SE45-5000-0000", "SEK", "personal", "keeper", idRes.id);
  assert.deepEqual(stale, []);
});

// ------------------------------------------------------------------------- G6

test("upsertAccounts: re-upserting the same uid with identification_hash undefined keeps the previously stored hash", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await db.upsertAccounts([
    { account_uid: "u1", session_pk: "s", name: "A", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "hash-keep" },
  ]);
  await db.upsertAccounts([
    { account_uid: "u1", session_pk: "s", name: "A", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  const rows = await db.allAccounts();
  assert.equal(rows.find((r) => r.account_uid === "u1").identification_hash, "hash-keep");
});

// ------------------------------------------------------------------------- F4

test("staleAccountGenerations: two batch rows sharing an identity are not folded into each other", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const identityId = "batchshared".padEnd(32, "0");
  await db.insertIdentityIgnore({ id: identityId, iban: null, identification_hash: "batch-shared-hash", currency: "SEK", psu_type: "personal" });
  await db.upsertAccounts([
    { account_uid: "batchA", session_pk: "s", name: "A", iban: "SESAME00001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "batchB", session_pk: "s", name: "B", iban: "SESAME00001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  await db.setAccountIdentityIfNull("batchA", identityId);
  await db.setAccountIdentityIfNull("batchB", identityId);

  const stale = await db.staleAccountGenerations("SESAME00001", "SEK", "personal", "batchA", identityId, ["batchA", "batchB"]);
  assert.deepEqual(stale, []);
});

test("staleAccountGenerations: a legacy row with the same IBAN and no identity pointer is folded", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await db.upsertAccounts([
    { account_uid: "legacy", session_pk: "s", name: "Legacy", iban: "SELEGACY001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "fresh", session_pk: "s", name: "Fresh", iban: "SELEGACY001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);

  const stale = await db.staleAccountGenerations("SELEGACY001", "SEK", "personal", "fresh", null, ["fresh"]);
  assert.deepEqual(stale, ["legacy"]);
});

// ------------------------------------------------------------------------- G2

test("staleAccountGenerations: when the new row has no IBAN, a same-identity candidate that does have one is not folded", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const identityId = "noibanfold".padEnd(32, "2");
  await db.insertIdentityIgnore({ id: identityId, iban: "SEHASIBAN01", identification_hash: null, currency: "SEK", psu_type: "personal" });
  await db.upsertAccounts([
    { account_uid: "u1", session_pk: "s", name: "Old", iban: "SEHASIBAN01", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "u2", session_pk: "s", name: "New", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  await db.setAccountIdentityIfNull("u1", identityId);
  await db.setAccountIdentityIfNull("u2", identityId);

  // New row (u2) has no IBAN, but u1 (same identity) carries one: must not fold.
  const stale = await db.staleAccountGenerations(null, "SEK", "personal", "u2", identityId, ["u2"]);
  assert.deepEqual(stale, []);
});

test("staleAccountGenerations: when the new row has no IBAN, a same-identity candidate that also has none may still be folded", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const identityId = "noibanfold2".padEnd(32, "3");
  await db.insertIdentityIgnore({ id: identityId, iban: null, identification_hash: "no-iban-hash", currency: "SEK", psu_type: "personal" });
  await db.upsertAccounts([
    { account_uid: "u1", session_pk: "s", name: "Old", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "u2", session_pk: "s", name: "New", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  await db.setAccountIdentityIfNull("u1", identityId);
  await db.setAccountIdentityIfNull("u2", identityId);

  const stale = await db.staleAccountGenerations(null, "SEK", "personal", "u2", identityId, ["u2"]);
  assert.deepEqual(stale, ["u1"]);
});

// ------------------------------------------------------------------------- H4

test("resolveAccountIdentity: a hash-only natural identity that matches an existing IBAN-bearing identity by hash fails closed (identity_conflict, no pointer, no fold)", async (t) => {
  const db = await setup(t);
  const withIban = { iban: "SEH4IBANTEST", identificationHash: "hash-h4", currency: "SEK", psuType: "personal" };
  const created = await resolveAccountIdentity(db, withIban);
  assert.equal(created.ok, true);

  const hashOnly = { iban: null, identificationHash: "hash-h4", currency: "SEK", psuType: "personal" };
  const result = await resolveAccountIdentity(db, hashOnly);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "identity_conflict");

  // The existing identity is untouched: still has its IBAN and hash, nothing new attached.
  const row = await db.identityById(created.id);
  assert.equal(row.iban, "SEH4IBANTEST");
  assert.equal(row.identification_hash, "hash-h4");
});

test("resolveAccountIdentity: a hash-only natural identity matching a hash-only (no-IBAN) identity still resolves normally", async (t) => {
  const db = await setup(t);
  const first = await resolveAccountIdentity(db, { iban: null, identificationHash: "hash-h4b", currency: "SEK", psuType: "personal" });
  assert.equal(first.ok, true);
  const second = await resolveAccountIdentity(db, { iban: null, identificationHash: "hash-h4b", currency: "SEK", psuType: "personal" });
  assert.equal(second.ok, true);
  assert.equal(second.id, first.id);
});

// ------------------------------------------------------------------------- H5

test("insertIdentityIgnore: a UNIQUE violation (duplicate id) returns false; a CHECK violation (no iban/hash) throws", async (t) => {
  const db = await setup(t);
  const id = crypto.randomUUID().replaceAll("-", "");
  const ok = await db.insertIdentityIgnore({ id, iban: "SEH5UNIQUE01", identification_hash: null, currency: "SEK", psu_type: "personal" });
  assert.equal(ok, true);
  const dup = await db.insertIdentityIgnore({ id, iban: "SEH5UNIQUE02", identification_hash: null, currency: "SEK", psu_type: "personal" });
  assert.equal(dup, false);

  await assert.rejects(() =>
    db.insertIdentityIgnore({ id: crypto.randomUUID().replaceAll("-", ""), iban: null, identification_hash: null, currency: "SEK", psu_type: "personal" })
  );
});

test("resolveAccountIdentity: the insert losing twice (never actually inserted, re-read finds nothing) returns transient_error, not identity_conflict", async (t) => {
  const db = await setup(t);
  const original = db.insertIdentityIgnore.bind(db);
  let calls = 0;
  db.insertIdentityIgnore = async () => { calls++; return false; };
  t.after(() => { db.insertIdentityIgnore = original; });

  const result = await resolveAccountIdentity(db, { iban: "SEH5TRANSIENT", identificationHash: null, currency: "SEK", psuType: "personal" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transient_error");
  assert.equal(calls, 2);
});

test("staleAccountGenerations: a same-identity candidate whose stored IBAN differs only in whitespace/case still folds (shared canonicalIban)", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const identityId = "canonshared".padEnd(32, "4");
  await db.insertIdentityIgnore({ id: identityId, iban: null, identification_hash: "canon-shared-hash", currency: "SEK", psu_type: "personal" });
  await db.upsertAccounts([
    { account_uid: "legacy2", session_pk: "s", name: "Legacy", iban: "se legacy 002", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "fresh2", session_pk: "s", name: "Fresh", iban: "SELEGACY002", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  await db.setAccountIdentityIfNull("legacy2", identityId);
  await db.setAccountIdentityIfNull("fresh2", identityId);

  const stale = await db.staleAccountGenerations("SELEGACY002", "SEK", "personal", "fresh2", identityId, ["fresh2"]);
  assert.deepEqual(stale, ["legacy2"]);
});

// ------------------------------------------------------------------------- J1

test("J1: IBAN is authoritative — a legacy row (no identity pointer) with the same IBAN but a different non-null hash is still folded", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await db.upsertAccounts([
    { account_uid: "legacy3", session_pk: "s", name: "Legacy", iban: "SEJ1HASH0001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "hash-old" },
    { account_uid: "fresh3", session_pk: "s", name: "Fresh", iban: "SEJ1HASH0001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "hash-new" },
  ]);

  const stale = await db.staleAccountGenerations("SEJ1HASH0001", "SEK", "personal", "fresh3", null, ["fresh3"]);
  assert.deepEqual(stale, ["legacy3"]);
});

test("J1: a legacy row (no identity pointer) with the same IBAN and a null hash is folded", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  await db.upsertAccounts([
    { account_uid: "legacy4", session_pk: "s", name: "Legacy", iban: "SEJ1HASH0002", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "fresh4", session_pk: "s", name: "Fresh", iban: "SEJ1HASH0002", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "hash-new2" },
  ]);

  const stale = await db.staleAccountGenerations("SEJ1HASH0002", "SEK", "personal", "fresh4", null, ["fresh4"]);
  assert.deepEqual(stale, ["legacy4"]);
});

// ------------------------------------------------------------------------- J2

test("J2: symmetric fail-closed — a same-identity candidate with no IBAN is not folded when the keeper has one; and a same-identity candidate with an IBAN is not folded when the keeper has none (both orders)", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const identityId = "j2symmetric".padEnd(32, "5");
  await db.insertIdentityIgnore({ id: identityId, iban: null, identification_hash: "j2-hash", currency: "SEK", psu_type: "personal" });
  await db.upsertAccounts([
    { account_uid: "j2noiban", session_pk: "s", name: "No IBAN", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "j2-hash" },
    { account_uid: "j2withiban", session_pk: "s", name: "With IBAN", iban: "SEJ2WITHIBAN", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "j2-hash" },
  ]);
  await db.setAccountIdentityIfNull("j2noiban", identityId);
  await db.setAccountIdentityIfNull("j2withiban", identityId);

  // Order 1: keeper has the IBAN, candidate has none.
  const staleIbanKeeper = await db.staleAccountGenerations("SEJ2WITHIBAN", "SEK", "personal", "j2withiban", identityId, ["j2withiban"]);
  assert.deepEqual(staleIbanKeeper, []);

  // Order 2: keeper has no IBAN, candidate has one (already covered by the
  // existing "when the new row has no IBAN" test, verified again here for symmetry).
  const staleNoIbanKeeper = await db.staleAccountGenerations(null, "SEK", "personal", "j2noiban", identityId, ["j2noiban"]);
  assert.deepEqual(staleNoIbanKeeper, []);
});

// ------------------------------------------------------------------------- J6

test("J6: assignAccountIdentities counts conflicts, errors and unavailable separately in its logged summary", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  // Conflict: hash H already belongs to an IBAN-bearing identity; a hash-only row matching H fails closed.
  await resolveAccountIdentity(db, { iban: "SEJ6IBAN0001", identificationHash: "j6-hash", currency: "SEK", psuType: "personal" });
  const rows = [
    { account_uid: "j6-conflict", session_pk: "s", name: "Conflict", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "j6-hash" },
    { account_uid: "j6-error", session_pk: "s", name: "Error", iban: "SEJ6ERROR001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "j6-unavailable", session_pk: "s", name: "Unavailable", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "j6-ok", session_pk: "s", name: "OK", iban: "SEJ6OK000001", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ];
  await db.upsertAccounts(rows);
  const original = db.identityByIban.bind(db);
  db.identityByIban = async (iban, currency, psuType) => {
    if (iban === "SEJ6ERROR001") throw new Error("simulated transient failure");
    return original(iban, currency, psuType);
  };
  t.after(() => { db.identityByIban = original; });

  const results = await assignAccountIdentities(db, rows);
  assert.equal(results.get("j6-conflict").reason, "identity_conflict");
  assert.equal(results.get("j6-error").reason, "transient_error");
  assert.equal(results.get("j6-unavailable").reason, "stable_identity_unavailable");
  assert.equal(results.get("j6-ok").ok, true);
});

test("staleAccountGenerations: a candidate pointing at the identity but with a different IBAN is not folded", async (t) => {
  const db = await setup(t);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const identityId = "diffiban".padEnd(32, "1");
  await db.insertIdentityIgnore({ id: identityId, iban: null, identification_hash: "diff-iban-hash", currency: "SEK", psu_type: "personal" });
  await db.upsertAccounts([
    { account_uid: "old", session_pk: "s", name: "Old", iban: "SEOLDIBAN01", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
    { account_uid: "newuid", session_pk: "s", name: "New", iban: "SENEWIBAN01", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null },
  ]);
  await db.setAccountIdentityIfNull("old", identityId);
  await db.setAccountIdentityIfNull("newuid", identityId);

  const stale = await db.staleAccountGenerations("SENEWIBAN01", "SEK", "personal", "newuid", identityId, ["newuid"]);
  assert.deepEqual(stale, []);
});
