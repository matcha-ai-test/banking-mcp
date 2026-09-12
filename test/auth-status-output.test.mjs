import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthStatus } from "../src/mcp-output.ts";

const session = {
  psu_type: "personal", aspsp_name: "Example Bank", aspsp_country: "SE",
  status: "active", valid_until: "2030-01-01T00:00:00Z", renewal_due: 0,
  refresh_count_date: null, refresh_count_today: 0, backoff_until: null,
  last_live_verified_at: null, last_live_result: null,
};

test("builder adds supplied live fields next to cached fields without copying unknown properties", () => {
  const result = buildAuthStatus([{ ...session, session_id: "secret-session" }], "2026-01-01", [{
    live_status: "EXPIRED", live_valid_until: "2026-01-01T00:00:00Z", live_cached: false, live_error: null, live_verified_at: "2026-01-01T00:00:00Z",
    accounts: ["secret-account"], START_TOKEN: "secret-token",
  }]);
  assert.equal(result.sessions[0].cached_status, "active");
  assert.equal(result.sessions[0].cached_valid_until, session.valid_until);
  assert.equal(result.sessions[0].live_status, "EXPIRED");
  assert.equal(result.sessions[0].live_valid_until, "2026-01-01T00:00:00Z");
  assert.equal(result.sessions[0].live_cached, false);
  assert.equal(result.sessions[0].live_error, null);
  assert.equal(result.sessions[0].live_verified_at, "2026-01-01T00:00:00Z");
  assert.equal(JSON.stringify(result).includes("secret-"), false);
});

test("builder handles cached failures and missing live dates without mixing sessions", () => {
  const result = buildAuthStatus([session, session], "2026-01-01", [
    { live_status: null, live_valid_until: null, live_error: "session_verification_failed", live_cached: true, live_verified_at: "2026-01-01T00:00:00Z" },
    { live_status: "AUTHORIZED", live_valid_until: null, live_cached: false, live_error: null, live_verified_at: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(result.sessions[0].live_error, "session_verification_failed");
  assert.equal(result.sessions[0].live_cached, true);
  assert.equal(result.sessions[1].live_status, "AUTHORIZED");
  assert.equal(result.sessions[1].live_valid_until, null);
  assert.equal(result.sessions[1].live_error, null);
});

test("builder preserves the cache-only shape when verification data is omitted", () => {
  const result = buildAuthStatus([session]);
  for (const key of ["live_status", "live_valid_until", "live_cached", "live_error", "live_verified_at"]) {
    assert.equal(key in result.sessions[0], false);
  }
  // Exact pre-change values and keys are independently covered in omitted-params.test.mjs.
});
