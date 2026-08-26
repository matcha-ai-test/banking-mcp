import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { writeClientCredentials } from "../scripts/lib/credentials.mjs";
import {
  ensureLocalWranglerConfig,
  localWranglerConfig,
  selectWranglerConfig,
  writeLocalBaseUrl,
} from "../scripts/lib/wrangler-config.mjs";
import { buildAuthStatus, buildSessionWarnings, serializeMcpText } from "../src/mcp-output.ts";
import { migrate } from "../src/migrate.ts";

function fakeSession(extra = {}) {
  return {
    id: "session-test-id",
    session_id: "upstream-session-test-id",
    psu_type: "personal",
    aspsp_name: "Example Bank",
    aspsp_country: "SE",
    valid_until: "2030-01-01T00:00:00.000Z",
    status: "expired",
    refresh_count_today: 1,
    refresh_count_date: "2026-08-26",
    renewal_due: 1,
    backoff_until: null,
    last_live_verified_at: "2026-08-26 10:00:00",
    last_live_result: "expired_session",
    updated_at: "2026-08-26 10:00:00",
    ...extra,
  };
}

test("MCP auth-status serialization never includes an injected START_TOKEN", () => {
  const fakeToken = "test-start-token-never-serialize";
  const session = fakeSession({ START_TOKEN: fakeToken });
  const response = serializeMcpText(
    buildSessionWarnings([session]),
    buildAuthStatus([session], "2026-08-26")
  );

  assert.equal(JSON.stringify(response).includes(fakeToken), false);
});

test("auth-status identifies cached metadata and exposes the last live result", () => {
  const status = buildAuthStatus([fakeSession()], "2026-08-26");

  assert.equal(status.sessions[0].cached, true);
  assert.equal(status.sessions[0].cached_status, "expired");
  assert.equal(status.sessions[0].last_live_result, "expired_session");
  assert.match(status.note, /metadata is cached/i);
});

test("setup credential writer uses mode 0600 and keeps secrets out of stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "banking-mcp-credentials-"));
  const filePath = join(dir, ".mcp-credentials");
  const mcpSecret = "test-connection-password";
  const startToken = "test-operator-start-token";
  const stdout = [];

  try {
    writeClientCredentials({
      filePath,
      mcpSecret,
      startToken,
      localUrl: "http://127.0.0.1:8787",
      cloudUrl: "https://worker.example.test",
      mode: "both",
      stdout: (line) => stdout.push(line),
    });

    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    const file = readFileSync(filePath, "utf8");
    assert.match(file, /MCP_URL=/);
    assert.match(file, /CONNECTION_PASSWORD=/);
    assert.match(file, /BANK_LINK=/);
    assert.ok(file.includes(mcpSecret));
    assert.ok(file.includes(startToken));
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes(filePath));
    assert.equal(stdout[0].includes(mcpSecret), false);
    assert.equal(stdout[0].includes(startToken), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local Wrangler override leaves the tracked template unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "banking-mcp-config-"));
  const trackedPath = join(dir, "wrangler.jsonc");
  const template = '{\n  "vars": { "BASE_URL": "http://127.0.0.1:8787" }\n}\n';

  try {
    writeFileSync(trackedPath, template);
    ensureLocalWranglerConfig(dir);
    writeLocalBaseUrl(dir, "https://worker.example.test");

    assert.equal(readFileSync(trackedPath, "utf8"), template);
    assert.match(readFileSync(localWranglerConfig(dir), "utf8"), /https:\/\/worker\.example\.test/);
    assert.equal(selectWranglerConfig(dir), localWranglerConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime migration is idempotent and adds live-verification columns", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const d1 = {
    prepare(sql) {
      return {
        async run() {
          sqlite.exec(sql);
          return { success: true, meta: {} };
        },
      };
    },
  };

  try {
    await migrate(d1);
    await migrate(d1);
    const columns = sqlite.prepare("PRAGMA table_info(eb_sessions)").all().map((row) => row.name);
    assert.ok(columns.includes("last_live_verified_at"));
    assert.ok(columns.includes("last_live_result"));
  } finally {
    sqlite.close();
  }
});
