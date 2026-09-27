import assert from "node:assert/strict";
import test from "node:test";

import { createEnv } from "./helpers.mjs";

// helpers.mjs registers the .ts resolver; import src after it, dynamically.
const { handleAuthorize } = await import("../src/oauth.ts");
const { pageResponse } = await import("../src/pages.ts");

function env(redirectUri, lookupClient = async () => null) {
  return {
    ...createEnv(),
    OAUTH_PROVIDER: {
      lookupClient,
      parseAuthRequest: async () => ({ clientId: "client-1", redirectUri, state: "s", scope: [] }),
      completeAuthorization: async () => ({ redirectTo: `${redirectUri}?code=x&state=s` }),
    },
  };
}

test("the OAuth consent page allows the client's redirect origin as a form-action target", async () => {
  const res = await handleAuthorize(new Request("https://worker.example.test/authorize?client_id=client-1"), env("https://claude.ai/api/mcp/auth_callback"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy"), /form-action 'self' https:\/\/claude\.ai;/);
});

test("an unparseable redirect_uri leaves form-action at 'self' only", async () => {
  const res = await handleAuthorize(new Request("https://worker.example.test/authorize?client_id=client-1"), env("not a url"));
  assert.match(res.headers.get("Content-Security-Policy"), /form-action 'self';/);
});

test("other pages keep form-action 'self'", () => {
  const res = pageResponse({ title: "t", body: "<h1>t</h1>" });
  assert.match(res.headers.get("Content-Security-Policy"), /form-action 'self';/);
});

async function consentHtml(redirectUri, lookupClient) {
  const res = await handleAuthorize(new Request("https://worker.example.test/authorize?client_id=client-1"), env(redirectUri, lookupClient));
  assert.equal(res.status, 200);
  return res.text();
}

const WARNING = /This will send access to .*Only approve if you started this sign-in yourself\./;

test("the consent page names the registered client and the redirect host", async () => {
  const html = await consentHtml("https://claude.ai/api/mcp/auth_callback", async () => ({ clientId: "client-1", clientName: "Claude" }));
  assert.match(html, /<strong>Claude<\/strong> \(client ID <code>client-1<\/code>\)/);
  assert.match(html, /returns to <strong><code>claude\.ai<\/code><\/strong>/);
  assert.doesNotMatch(html, WARNING);
});

test("claude.com and Claude subdomains are expected hosts; look-alikes are not", async () => {
  for (const uri of ["https://claude.com/cb", "https://app.claude.ai/cb", "https://x.claude.com/cb"]) {
    assert.doesNotMatch(await consentHtml(uri), WARNING, uri);
  }
  for (const uri of ["https://claude.ai.evil.example/cb", "https://evilclaude.ai/cb", "http://claude.ai/cb", "https://attacker.example/cb", "not a url"]) {
    assert.match(await consentHtml(uri), WARNING, uri);
  }
});

test("a foreign redirect host is shown in the warning and everything is escaped", async () => {
  const html = await consentHtml("https://attacker.example:8443/cb", async () => ({ clientId: "client-1", clientName: '<img src=x onerror="alert(1)">' }));
  assert.match(html, /This will send access to attacker\.example:8443\./);
  assert.ok(!html.includes("<img"), "client name must be escaped");
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("a failing client lookup still renders the page with the client ID", async () => {
  const html = await consentHtml("https://claude.ai/cb", async () => { throw new Error("metadata fetch failed"); });
  assert.match(html, /Client <code>client-1<\/code> is asking/);
});
