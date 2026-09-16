// Regression tests for the five first-run blockers: CIMD error reporting,
// Enable Banking signature diagnostics, D1-independent static pages, the
// /mcp wrong-password gate, and Worker/D1 name derivation.

import assert from "node:assert/strict";
import test from "node:test";

import { authCookieHeader, createEnv, mockEnableBanking, request } from "./helpers.mjs";
// Stubs `cloudflare:workers` so the real Worker entrypoint can be imported here.
import "./cloudflare-stub.mjs";

// helpers.mjs registers the .ts resolver; import src after it, dynamically.
const { handleAuthorize } = await import("../src/oauth.ts");
const { handleAuthStart } = await import("../src/auth.ts");
const { privacyPage, termsPage, homePage } = await import("../src/pages.ts");
const { mcpGateDecision, wrongPasswordResponse } = await import("../src/util.ts");
const { deriveWorkerNames, applyWorkerNames } = await import("../scripts/lib/wrangler-config.mjs");

const CLOUD = "https://worker.example.test";

function withFetch(t, routes) {
  const mock = mockEnableBanking(routes);
  t.after(() => mock.restore());
  return mock;
}

// ------------------------------------------------------------------- 1. CIMD

function failingProvider(message) {
  return {
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => {
        throw new Error(message);
      },
      completeAuthorization: async () => {
        throw new Error("not reached");
      },
    },
  };
}

test("the authorize catch shows the provider's own message instead of a bare page", async () => {
  const env = { ...(await createEnv()), ...failingProvider("Invalid client_id") };
  const res = await handleAuthorize(new Request(`${CLOUD}/authorize?client_id=abc123`), env);
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Invalid OAuth request/);
  assert.match(html, /Invalid client_id/);
});

test("an https client_id gets the CIMD hint pointing at Register automatically", async () => {
  const env = { ...(await createEnv()), ...failingProvider("Invalid client_id") };
  const clientId = "https://claude.ai/api/mcp/client-metadata.json";
  const res = await handleAuthorize(
    new Request(`${CLOUD}/authorize?client_id=${encodeURIComponent(clientId)}`),
    env
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /client ID metadata document/);
  assert.match(html, /Register automatically/);
});

test("a non-URL client_id gets no CIMD hint", async () => {
  const env = { ...(await createEnv()), ...failingProvider("Invalid client_id") };
  const res = await handleAuthorize(new Request(`${CLOUD}/authorize?client_id=abc123`), env);
  const html = await res.text();
  assert.equal(/Register automatically/.test(html), false);
});

test("the provider message is HTML-escaped before it reaches the page", async () => {
  const env = { ...(await createEnv()), ...failingProvider("<script>bad()</script>") };
  const res = await handleAuthorize(new Request(`${CLOUD}/authorize?client_id=abc`), env);
  const html = await res.text();
  assert.equal(html.includes("<script>bad()</script>"), false);
  assert.match(html, /&lt;script&gt;/);
});

// ----------------------------------------- 2. Wrong Application ID diagnostics

const ebError = (status) =>
  new Response(JSON.stringify({ code: status, message: "Wrong signature" }), {
    status,
    headers: { "content-type": "application/json" },
  });

async function startRequest() {
  return request(`${CLOUD}/auth/start?bank=Mock%20ASPSP&country=FI`, {
    headers: { Cookie: await authCookieHeader() },
    ip: "203.0.113.10",
  });
}

test("a 401 from Enable Banking renders the signature-mismatch page, not Internal error", async (t) => {
  const env = await createEnv();
  withFetch(t, { "GET /aspsps": () => ebError(401) });
  const res = await handleAuthStart(await startRequest(), env);
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /rejected the signature/i);
  assert.match(html, /does not match the private key|does not match the configured Application ID/i);
  assert.match(html, /Control Panel/);
});

test("the signature page does not leak the Enable Banking response body", async (t) => {
  const env = await createEnv();
  withFetch(t, { "GET /aspsps": () => ebError(401) });
  const res = await handleAuthStart(await startRequest(), env);
  const html = await res.text();
  assert.equal(html.includes("Wrong signature"), false);
});

test("other Enable Banking failures render a generic status page", async (t) => {
  const env = await createEnv();
  withFetch(t, { "GET /aspsps": () => ebError(403) });
  const res = await handleAuthStart(await startRequest(), env);
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /Enable Banking request failed \(403\)/);
});

test("a 401 while starting the bank authorization is also reported", async (t) => {
  const env = await createEnv();
  withFetch(t, {
    "GET /aspsps": { aspsps: [{ name: "Mock ASPSP", country: "FI", psu_types: ["personal"] }] },
    "POST /auth": () => ebError(401),
  });
  const res = await handleAuthStart(await startRequest(), env);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /rejected the signature/i);
});

// ------------------------------------------------- 3. Static pages without D1

/** An Env whose D1 binding throws on any use, like a Worker deployed without D1. */
function brokenDbEnv() {
  const thrower = () => {
    throw new Error("D1_ERROR: no such database");
  };
  return {
    DB: {
      prepare: thrower,
      batch: thrower,
    },
    MCP_SECRET: "test-mcp-secret",
    START_TOKEN: "test-start-token",
    EB_APP_ID: "00000000-0000-4000-8000-000000000000",
    EB_PRIVATE_KEY: "unused",
  };
}

test("the static pages are pure functions that never touch D1", async () => {
  for (const res of [privacyPage(), termsPage(), homePage(true), homePage(false)]) {
    assert.equal(res.status, 200);
    assert.ok((await res.text()).length > 0);
  }
});

test("/privacy and /terms are served with an Env whose DB.prepare throws", async () => {
  const worker = (await import("../src/index.ts")).default;
  const env = brokenDbEnv();
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  for (const path of ["/privacy", "/terms", "/"]) {
    const res = await worker.fetch(new Request(`${CLOUD}${path}`), env, ctx);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/, path);
  }
});

test("a route that does need D1 degrades to a plain 500, not a Worker exception", async () => {
  const worker = (await import("../src/index.ts")).default;
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const res = await worker.fetch(new Request(`${CLOUD}/auth/callback?code=x&state=y`), brokenDbEnv(), ctx);
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "Internal error");
});

// ------------------------------------------------------- 4. /mcp gate decision

const SECRET = "test-mcp-secret";
const mcpReq = (headers = {}) => new Request(`${CLOUD}/mcp`, { method: "POST", headers });

test("a wrong x-api-key is rejected rather than handed to the OAuth provider", async () => {
  assert.equal(await mcpGateDecision(mcpReq({ "x-api-key": "wrong" }), SECRET), "reject");
});

test("a bearer that is not the connection password still reaches the OAuth provider", async () => {
  // Only the provider can tell a valid OAuth access token from an invalid one,
  // so rejecting here would lock out every legitimate OAuth client.
  assert.equal(await mcpGateDecision(mcpReq({ authorization: "Bearer some-oauth-access-token" }), SECRET), "oauth");
});

test("a request with no presented secret falls through to the OAuth provider", async () => {
  assert.equal(await mcpGateDecision(mcpReq(), SECRET), "oauth");
  assert.equal(await mcpGateDecision(mcpReq({ "x-api-key": "  " }), SECRET), "oauth");
});

test("a wrong x-api-key next to a bearer still goes to the OAuth provider", async () => {
  // claude.ai sends a Sign-in connector's configured request headers alongside
  // the OAuth bearer, so a stale or mistyped x-api-key left on an OAuth
  // connector must not kill every OAuth request before the token is validated.
  assert.equal(
    await mcpGateDecision(mcpReq({ authorization: "Bearer some-oauth-access-token", "x-api-key": "wrong" }), SECRET),
    "oauth"
  );
});

test("the reject path needs an API key header and no bearer", async () => {
  assert.equal(await mcpGateDecision(mcpReq({ "x-api-key": "wrong" }), SECRET), "reject");
  assert.equal(await mcpGateDecision(mcpReq({ "api-key": "wrong", authorization: "Bearer x" }), SECRET), "oauth");
  // A non-Bearer Authorization scheme is not a bearer, so the reject path stands.
  assert.equal(await mcpGateDecision(mcpReq({ "x-api-key": "wrong", authorization: "Basic x" }), SECRET), "reject");
});

test("a correct credential is allowed in either header", async () => {
  assert.equal(await mcpGateDecision(mcpReq({ "x-api-key": SECRET }), SECRET), "allow");
  assert.equal(await mcpGateDecision(mcpReq({ authorization: `Bearer ${SECRET}` }), SECRET), "allow");
});

test("a stale bearer alongside a correct x-api-key still allows the request", async () => {
  assert.equal(await mcpGateDecision(mcpReq({ authorization: "Bearer stale", "x-api-key": SECRET }), SECRET), "allow");
});

test("the wrong-password response is a short 401 with no WWW-Authenticate", async () => {
  const res = wrongPasswordResponse();
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("WWW-Authenticate"), null);
  assert.equal(await res.text(), "Wrong connection password");
});

test("the worker answers a wrong x-api-key with 401 and no WWW-Authenticate", async () => {
  const worker = (await import("../src/index.ts")).default;
  const env = await createEnv();
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const res = await worker.fetch(mcpReq({ "x-api-key": "wrong" }), env, ctx);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("WWW-Authenticate"), null);
  assert.equal(await res.text(), "Wrong connection password");
});

// ------------------------------------------------------ 5. Worker / D1 naming

test("the default names match the tracked wrangler.jsonc", () => {
  assert.deepEqual(deriveWorkerNames(undefined), { workerName: "banking-mcp", databaseName: "banking-mcp-db" });
  assert.deepEqual(deriveWorkerNames(""), { workerName: "banking-mcp", databaseName: "banking-mcp-db" });
  assert.deepEqual(deriveWorkerNames("   "), { workerName: "banking-mcp", databaseName: "banking-mcp-db" });
});

test("a chosen worker name derives the database name", () => {
  assert.deepEqual(deriveWorkerNames("banking-mcp-test"), {
    workerName: "banking-mcp-test",
    databaseName: "banking-mcp-test-db",
  });
  assert.deepEqual(deriveWorkerNames(" my-bank2 "), { workerName: "my-bank2", databaseName: "my-bank2-db" });
});

test("invalid worker names are refused rather than silently deployed", () => {
  for (const bad of ["Banking_MCP", "has space", "-leading", "trailing-", "a".repeat(64), "under_score"]) {
    assert.throws(() => deriveWorkerNames(bad), /not a valid Worker name/, bad);
  }
});

test("a single-character worker name is accepted", () => {
  assert.deepEqual(deriveWorkerNames("a"), { workerName: "a", databaseName: "a-db" });
});

test("applyWorkerNames rewrites both names and nothing else", () => {
  const source = `{
  "name": "banking-mcp",
  "main": "src/index.ts",
  "vars": { "BASE_URL": "http://127.0.0.1:8787" },
  "d1_databases": [{ "binding": "DB", "database_name": "banking-mcp-db" }]
}`;
  const out = applyWorkerNames(source, deriveWorkerNames("banking-mcp-test"));
  assert.match(out, /"name":\s*"banking-mcp-test"/);
  assert.match(out, /"database_name":\s*"banking-mcp-test-db"/);
  assert.match(out, /"main":\s*"src\/index\.ts"/);
  assert.match(out, /"BASE_URL":\s*"http:\/\/127\.0\.0\.1:8787"/);
  // The binding name is not a Worker name and must survive untouched.
  assert.match(out, /"binding":\s*"DB"/);
});
