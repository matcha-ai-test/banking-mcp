import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createD1, createEnv } from "./helpers.mjs";
const { migrate } = await import("../src/migrate.ts");

test("public migration adds missing verification columns idempotently and preserves sync evidence", async (t) => {
  const env = await createEnv();
  t.after(() => env.DB.close());
  for (const column of ["live_verify_claimed_at", "live_verify_result"]) {
    env.DB.sqlite.exec(`ALTER TABLE eb_sessions DROP COLUMN ${column}`);
  }
  env.DB.sqlite.exec("INSERT INTO eb_sessions (id, session_id, psu_type, last_live_result) VALUES ('local', 'upstream', 'personal', 'ok')");
  await migrate(env.DB);
  await migrate(env.DB);
  const row = env.DB.sqlite.prepare("SELECT * FROM eb_sessions").get();
  assert.equal(row.live_verify_claimed_at, null);
  assert.equal(row.live_verify_result, null);
  assert.equal(row.last_live_result, "ok");
});

test("public detail timestamp migration is additive and idempotent on an existing cache", async (t) => {
  const env = await createEnv();
  t.after(() => env.DB.close());
  env.DB.sqlite.exec("ALTER TABLE transactions DROP COLUMN detail_fetched_at");
  env.DB.sqlite.exec("ALTER TABLE transactions DROP COLUMN detail_claimed_at");
  env.DB.sqlite.exec("INSERT INTO eb_sessions (id, session_id, psu_type) VALUES ('session', 'upstream', 'personal')");
  env.DB.sqlite.exec("INSERT INTO accounts (account_uid, session_pk, psu_type) VALUES ('example', 'session', 'personal')");
  env.DB.sqlite.exec("INSERT INTO transactions (account_uid, booking_date, amount_cents, currency, credit_debit, dedup_key, raw) VALUES ('example', '2030-01-01', 1234, 'EUR', 'CRDT', 'stable', '{}')");
  await migrate(env.DB);
  await migrate(env.DB);
  const row = env.DB.sqlite.prepare("SELECT * FROM transactions").get();
  assert.equal(row.detail_fetched_at, null);
  assert.equal(row.detail_claimed_at, null);
  assert.equal(row.dedup_key, "stable");
  assert.equal(row.raw, "{}");
});

// ---- Step 0 §0.7: shared migration tests, built from the pre-feature (origin/main HEAD) schema ----

function legacySchema() {
  return execFileSync("git", ["show", "HEAD:schema.sql"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
}

test("legacy schema from HEAD migrates twice, keeps rows, adds every new column and table", async (t) => {
  const DB = createD1();
  t.after(() => DB.close());
  DB.sqlite.exec(legacySchema());
  DB.sqlite.exec("INSERT INTO eb_sessions (id, session_id, psu_type) VALUES ('s', 'u', 'personal')");
  DB.sqlite.exec("INSERT INTO accounts (account_uid, session_pk, psu_type, iban) VALUES ('a', 's', 'personal', 'SE1')");
  DB.sqlite.exec(
    "INSERT INTO transactions (account_uid, booking_date, amount_cents, currency, credit_debit, dedup_key, raw) VALUES ('a', '2030-01-01', 1234, 'SEK', 'DBIT', 'dk1', '{}')"
  );
  const before = DB.sqlite.prepare("SELECT * FROM transactions").get();

  await migrate(DB);
  await migrate(DB);

  const accountCols = DB.sqlite.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  for (const col of ["identification_hash", "account_identity_id"]) {
    assert.ok(accountCols.includes(col), `accounts.${col} missing`);
  }
  const tables = DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  for (const table of ["account_identities", "account_labels", "aspsp_cache"]) {
    assert.ok(tables.includes(table), `${table} missing`);
  }
  const after = DB.sqlite.prepare("SELECT * FROM transactions").get();
  assert.deepEqual(after, before);
});

test("a non-duplicate ALTER failure propagates", async (t) => {
  const DB = createD1();
  t.after(() => DB.close());
  const real = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    if (sql.includes("ALTER TABLE accounts ADD COLUMN identification_hash")) {
      return { run: async () => { throw new Error("no such table: accounts"); } };
    }
    return real(sql);
  };
  await assert.rejects(migrate(DB));
});

test("fresh createEnv() equals legacy-then-migrate", async (t) => {
  const fresh = await createEnv();
  t.after(() => fresh.DB.close());
  const legacy = createD1();
  t.after(() => legacy.close());
  legacy.sqlite.exec(legacySchema());
  await migrate(legacy);
  await migrate(legacy);

  const tableInfo = (db, table) =>
    db.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();
  const tables = (db) =>
    db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);

  assert.deepEqual(tables(fresh.DB), tables(legacy));
  for (const table of tables(fresh.DB)) {
    assert.deepEqual(tableInfo(fresh.DB, table), tableInfo(legacy, table), `table_info mismatch for ${table}`);
  }
});
