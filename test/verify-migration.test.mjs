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
