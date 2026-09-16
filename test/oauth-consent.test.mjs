import assert from "node:assert/strict";
import test from "node:test";

import { createEnv } from "./helpers.mjs";

// helpers.mjs registers the .ts resolver; import src after it, dynamically.
const { handleAuthorize } = await import("../src/oauth.ts");
const { pageResponse } = await import("../src/pages.ts");

function env(redirectUri) {
  return {
    ...createEnv(),
    OAUTH_PROVIDER: {
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
