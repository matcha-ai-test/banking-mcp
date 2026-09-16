import assert from "node:assert/strict";
import test from "node:test";

import { apiKeyFrom, bearerFrom, presentedSecrets, secretsMatch } from "../src/util.ts";

const SECRET = "connection-password-under-test";

// Every header name claude.ai offers in its custom connector header picker.
// `Authorization` is reserved there, which is why these exist at all.
const API_KEY_HEADERS = ["x-api-key", "api-key", "apikey", "x-apikey", "x-api-token", "api-token", "x-auth-token"];

function req(headers = {}) {
  return new Request("https://worker.example.test/mcp", { headers });
}

test("bearer credentials still reach the /mcp gate", () => {
  assert.equal(bearerFrom(req({ authorization: `Bearer ${SECRET}` })), SECRET);
  assert.deepEqual(presentedSecrets(req({ authorization: `Bearer ${SECRET}` })), [SECRET]);
});

test("claude.ai No sign-in connectors can present the password as x-api-key", () => {
  assert.equal(apiKeyFrom(req({ "x-api-key": SECRET })), SECRET);
  assert.deepEqual(presentedSecrets(req({ "x-api-key": SECRET })), [SECRET]);
});

test("every header name claude.ai allows is accepted", () => {
  for (const name of API_KEY_HEADERS) {
    assert.equal(apiKeyFrom(req({ [name]: SECRET })), SECRET, name);
    assert.deepEqual(presentedSecrets(req({ [name]: SECRET })), [SECRET], name);
  }
});

test("header names are matched case-insensitively", () => {
  assert.equal(apiKeyFrom(req({ "X-Api-Key": SECRET })), SECRET);
  assert.deepEqual(presentedSecrets(req({ "X-Api-Key": SECRET })), [SECRET]);
});

test("a blank header does not hide a populated one", () => {
  assert.equal(apiKeyFrom(req({ "x-api-key": "", "api-key": SECRET })), SECRET);
  assert.equal(apiKeyFrom(req({ "x-api-key": "   ", "api-key": SECRET })), SECRET);
  assert.deepEqual(presentedSecrets(req({ "x-api-key": "  ", "api-key": SECRET })), [SECRET]);
});

test("an empty API key header is not a credential", () => {
  assert.equal(apiKeyFrom(req({ "x-api-key": "" })), null);
  assert.equal(apiKeyFrom(req({ "x-api-key": "   " })), null);
  assert.equal(apiKeyFrom(req()), null);
  assert.deepEqual(presentedSecrets(req({ "x-api-key": "" })), []);
  assert.deepEqual(presentedSecrets(req()), []);
});

test("a bearer token comes first when both are present", () => {
  const request = req({ authorization: `Bearer ${SECRET}`, "x-api-key": "other-value" });
  assert.deepEqual(presentedSecrets(request), [SECRET, "other-value"]);
});

test("a stale bearer plus a correct x-api-key yields both candidates", async () => {
  const candidates = presentedSecrets(req({ authorization: "Bearer stale-oauth-token", "x-api-key": SECRET }));
  assert.deepEqual(candidates, ["stale-oauth-token", SECRET]);
  const matches = await Promise.all(candidates.map((c) => secretsMatch(c, SECRET)));
  assert.deepEqual(matches, [false, true]);
  assert.ok(matches.some(Boolean), "the gate accepts the request because one candidate matches");
});

test("a non-Bearer Authorization scheme is not read as a bearer token", () => {
  assert.equal(bearerFrom(req({ authorization: `Basic ${SECRET}` })), null);
  assert.deepEqual(presentedSecrets(req({ authorization: `Basic ${SECRET}` })), []);
});

test("the API key header is compared against MCP_SECRET", async () => {
  assert.equal(await secretsMatch(apiKeyFrom(req({ "x-api-key": SECRET })), SECRET), true);
  assert.equal(await secretsMatch(apiKeyFrom(req({ "x-api-key": "wrong-password" })), SECRET), false);
  assert.equal(await secretsMatch(apiKeyFrom(req()), SECRET), false);
});

test("no candidate matches when every presented credential is wrong", async () => {
  const candidates = presentedSecrets(req({ authorization: "Bearer nope", "x-api-key": "also-nope" }));
  const matches = await Promise.all(candidates.map((c) => secretsMatch(c, SECRET)));
  assert.equal(matches.some(Boolean), false);
});
