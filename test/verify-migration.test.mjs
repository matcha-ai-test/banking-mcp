import assert from "node:assert/strict";
import test from "node:test";
import { createEnv } from "./helpers.mjs";
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
