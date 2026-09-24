import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

// ---- Step 2: categories, rules and overrides ----

const STEP2_TABLES = ["categories", "categorization_rules", "transaction_category_overrides"];
const STEP2_INDEXES = ["idx_rules_scope_priority", "idx_rules_category", "idx_overrides_category"];

/** The pre-Step-2 schema, whatever HEAD is: HEAD's schema.sql minus the purely additive Step 2 tables. */
function preStep2Schema(DB) {
  DB.sqlite.exec(legacySchema());
  for (const table of [...STEP2_TABLES].reverse()) DB.sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
}

test("Step 2: a pre-feature database gains the category tables, idempotently, without touching existing rows", async (t) => {
  const DB = createD1();
  t.after(() => DB.close());
  preStep2Schema(DB);
  DB.sqlite.exec("INSERT INTO eb_sessions (id, session_id, psu_type) VALUES ('s', 'u', 'personal')");
  DB.sqlite.exec("INSERT INTO accounts (account_uid, session_pk, psu_type, iban) VALUES ('a', 's', 'personal', 'SE1')");
  DB.sqlite.exec(
    "INSERT INTO transactions (account_uid, booking_date, amount_cents, currency, credit_debit, dedup_key, raw) VALUES ('a', '2030-01-01', 1234, 'SEK', 'DBIT', 'dk1', '{}')"
  );
  const dump = () => ({
    accounts: DB.sqlite.prepare("SELECT * FROM accounts").all(),
    transactions: DB.sqlite.prepare("SELECT * FROM transactions").all(),
  });
  const before = dump();
  await migrate(DB);
  DB.sqlite.exec("INSERT INTO categories (id, name, name_key) VALUES ('c1', 'Food', 'food')");
  await migrate(DB); // second run must neither fail nor drop the new row
  const names = DB.sqlite.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name);
  for (const n of [...STEP2_TABLES, ...STEP2_INDEXES]) assert.ok(names.includes(n), `${n} missing`);
  assert.deepEqual(dump(), before);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM categories").get().n, 1);
});

test("Step 2: schema.sql and migrate.ts define the category tables identically (columns, constraints, indexes)", async (t) => {
  const fromMigrate = await createEnv();
  t.after(() => fromMigrate.DB.close());
  const fromSchema = createD1();
  t.after(() => fromSchema.close());
  fromSchema.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const ddl = (db, name) => db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql.replace(/\s+/g, " ");
  for (const n of [...STEP2_TABLES, ...STEP2_INDEXES]) {
    assert.ok(ddl(fromSchema, n), `${n} missing from schema.sql`);
    assert.equal(ddl(fromMigrate.DB, n), ddl(fromSchema, n), n);
  }
});

test("Step 2: the DDL is a second boundary: catch-alls, amount without currency, bad keys and dangling references are refused", async (t) => {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const s = env.DB.sqlite;
  s.exec("INSERT INTO categories (id, name, name_key) VALUES ('c1', 'Food', 'food')");
  const rule = (cols) => {
    const keys = Object.keys(cols);
    s.prepare(`INSERT INTO categorization_rules (id, category_id, direction, ${keys.join(", ")}) VALUES ('r' || abs(random()), 'c1', 'out', ${keys.map(() => "?").join(", ")})`)
      .run(...Object.values(cols));
  };
  rule({ counterparty_mode: "contains", counterparty_pattern: "grocery" });
  assert.throws(() => rule({ currency: "SEK" }), /CHECK/); // global catch-all
  assert.throws(() => rule({ amount_min_cents: 1 }), /CHECK/); // amount without currency
  assert.throws(() => rule({ counterparty_mode: "regex", counterparty_pattern: ".*" }), /CHECK/);
  assert.throws(() => rule({ amount_min_cents: 1.5, currency: "SEK" }), /CHECK/);
  assert.throws(() => rule({ counterparty_mode: "exact", counterparty_pattern: "x", booking_day_from: 5 }), /CHECK/);
  assert.throws(() => s.prepare("INSERT INTO categorization_rules (id, category_id, direction, counterparty_mode, counterparty_pattern) VALUES ('x', 'missing', 'out', 'exact', 'x')").run(), /FOREIGN KEY/);
  assert.throws(() => s.prepare("DELETE FROM categories WHERE id = 'c1'").run(), /FOREIGN KEY/); // RESTRICT: decisions are never silently lost
  s.exec("INSERT INTO eb_sessions (id, session_id, psu_type) VALUES ('s', 'u', 'personal')");
  s.exec("INSERT INTO account_identities (id, iban, currency, psu_type) VALUES ('" + "a".repeat(32) + "', 'SE4550000000058398257466', 'SEK', 'personal')");
  const override = (key, cd = "DBIT") => s.prepare(
    "INSERT INTO transaction_category_overrides (account_identity_id, transaction_key, category_id, booking_date, amount_cents, currency, credit_debit) VALUES (?, ?, NULL, '2030-01-01', 1, 'SEK', ?)"
  ).run("a".repeat(32), key, cd);
  override("f".repeat(64));
  assert.throws(() => override("F".repeat(64)), /CHECK/);
  assert.throws(() => override("f".repeat(63)), /CHECK/);
  assert.throws(() => override("e".repeat(64), "BOOK"), /CHECK/);
});

test("Step 2: the pre-Step-2 migrate.ts still runs on the new schema (old code, new database)", async (t) => {
  let oldSource;
  try {
    oldSource = execFileSync("git", ["show", "37d970d:src/migrate.ts"], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    t.skip("pre-Step-2 commit not available (shallow clone)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "banking-mcp-old-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "migrate.ts");
  writeFileSync(file, oldSource);
  const { migrate: oldMigrate } = await import(pathToFileURL(file).href);
  const env = await createEnv(); // new schema
  t.after(() => env.DB.close());
  env.DB.sqlite.exec("INSERT INTO categories (id, name, name_key) VALUES ('c1', 'Food', 'food')");
  await oldMigrate(env.DB);
  await oldMigrate(env.DB);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM categories").get().n, 1);
  // The queries the old code issues are unaffected: no existing table changed shape.
  env.DB.sqlite.exec("INSERT INTO eb_sessions (id, session_id, psu_type) VALUES ('s', 'u', 'personal')");
  env.DB.sqlite.exec("INSERT INTO accounts (account_uid, session_pk, psu_type) VALUES ('a', 's', 'personal')");
  env.DB.sqlite.exec("INSERT INTO transactions (account_uid, booking_date, amount_cents, currency, credit_debit, dedup_key) VALUES ('a', '2030-01-01', 1, 'SEK', 'DBIT', 'k')");
  assert.equal(env.DB.sqlite.prepare("SELECT * FROM transactions ORDER BY booking_date DESC, id DESC LIMIT 1").get().dedup_key, "k");
});
