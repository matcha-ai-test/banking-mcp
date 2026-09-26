import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Db } from "./db";
import { grantProps } from "./grant";
import { esc, pageResponse } from "./pages";
import { isRealSecret } from "./settings";
import type { Env } from "./types";
import { rateLimitKey, secretsMatch } from "./util";

const AUTHORIZE_ATTEMPTS_PER_HOUR = 10;

/** Origin of the client's redirect_uri, allowed as a CSP form-action target. */
function redirectOrigin(redirectUri: string | undefined): string[] {
  try {
    const url = new URL(redirectUri ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? [url.origin] : [];
  } catch {
    return [];
  }
}

/**
 * A bare "Invalid OAuth request" tells the operator nothing, and the most
 * common cause is a client_id that is an https URL (claude.ai's "Use Claude's
 * published identity") whose metadata document could not be resolved. The
 * provider's own message names the check that failed and carries no secrets and
 * no request headers. It can echo values from the client's metadata document,
 * so it is escaped and served under the page's strict nonce CSP; it is plain
 * reflected text on a 400, never markup.
 */
function invalidRequestPage(url: URL, error: unknown): Response {
  const detail = error instanceof Error && error.message ? error.message : "";
  const clientId = url.searchParams.get("client_id") ?? "";
  const cimdHint = /^https:\/\//i.test(clientId)
    ? `<p>The client identified itself with an https URL, which means it is using a client ID metadata document. If this keeps failing, switch the connector's client option to <strong>Register automatically</strong> (dynamic client registration) and try again.</p>`
    : "";
  return pageResponse({
    title: "Invalid OAuth request",
    body: `<h1>Invalid OAuth request</h1>${detail ? `<p class="err">${esc(detail)}</p>` : ""}${cimdHint}<p class="hint">Nothing was approved and no access was granted.</p>`,
    status: 400,
  });
}

/** Redirect hosts the consent page treats as expected: Claude's own web apps and their subdomains. */
const EXPECTED_REDIRECT_DOMAINS = ["claude.ai", "claude.com"];

/** Host (with port) of the redirect_uri, and whether it is an https Claude host. */
function redirectTarget(redirectUri: string | undefined): { host: string | null; expected: boolean } {
  try {
    const url = new URL(redirectUri ?? "");
    const hostname = url.hostname.toLowerCase();
    const expected = url.protocol === "https:" &&
      EXPECTED_REDIRECT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    return { host: url.host || null, expected };
  } catch {
    return { host: null, expected: false };
  }
}

/**
 * The registered client_name, when the provider knows one. Best-effort: a
 * lookup failure (for example an unreachable client metadata document) only
 * drops the name from the page; the client_id is always shown.
 */
async function registeredClientName(env: Env & { OAUTH_PROVIDER: OAuthHelpers }, clientId: string): Promise<string | null> {
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient?.(clientId);
    const name = client?.clientName?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

interface ConsentView {
  clientId: string;
  clientName: string | null;
  redirectUri: string | undefined;
}

function consentForm(view: ConsentView, failed = false): Response {
  const { host, expected } = redirectTarget(view.redirectUri);
  const hostLabel = host ?? "an unrecognized address";
  const client = view.clientName
    ? `<strong>${esc(view.clientName)}</strong> (client ID <code>${esc(view.clientId)}</code>)`
    : `<code>${esc(view.clientId)}</code>`;
  const destination = `<p>After approval the browser returns to <strong><code>${esc(hostLabel)}</code></strong>.</p>`;
  const warning = expected
    ? ""
    : `<p class="err" role="alert">This will send access to ${esc(hostLabel)}. Only approve if you started this sign-in yourself.</p>`;
  const body = `<h1>Approve the banking-mcp connection</h1><p>Client ${client} is asking for <strong>read-only</strong> access to your linked bank data and permission to store local labels, categories and rules in this server's own cache. banking-mcp has no bank-side write functions.</p>${destination}${warning}${failed ? '<p class="err" role="alert">Wrong connection password. Try again.</p>' : ""}<form method="POST" autocomplete="off"><label for="password">Connection password</label><input id="password" type="password" name="password" autocomplete="current-password" autofocus required><div class="actions"><button type="submit">Approve</button></div></form><p class="hint">Only the operator can approve. The installer stores this password in local <code>.dev.vars</code> or as an encrypted Cloudflare Worker secret.</p>`;
  return pageResponse({ title: "Approve connection", body, status: failed ? 401 : 200, formActionOrigins: redirectOrigin(view.redirectUri) });
}

/**
 * OAuth authorize endpoint for a single-operator server: the "login" is a
 * connect password (MCP_SECRET). PKCE, token issuance and client registration
 * are handled by workers-oauth-provider.
 */
export async function handleAuthorize(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
  const url = new URL(request.url);
  const parseReq = request.method === "GET" ? request : new Request(url.toString(), { method: "GET" });
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(parseReq);
  } catch (e) {
    return invalidRequestPage(url, e);
  }

  const view: ConsentView = {
    clientId: oauthReq.clientId,
    clientName: await registeredClientName(env, oauthReq.clientId),
    redirectUri: oauthReq.redirectUri,
  };
  if (request.method === "GET") {
    return consentForm(view);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const db = new Db(env);
  if (!(await db.rateLimitOk(await rateLimitKey(request, "authorize"), AUTHORIZE_ATTEMPTS_PER_HOUR, 3600_000))) {
    return pageResponse({ title: "Too many attempts", body: "<h1>Too many attempts</h1><p>Wait an hour and try again.</p>", status: 429 });
  }

  const form = await request.formData();
  const password = form.get("password")?.toString() ?? "";
  // The route is already closed while unconfigured; refusing a placeholder
  // here too means a deploy-button seeded "generated-connection-password" can
  // never approve a grant even if that gate is bypassed.
  if (!isRealSecret(env.MCP_SECRET) || !(await secretsMatch(password, env.MCP_SECRET))) {
    return consentForm(view, true);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "operator",
    metadata: { approvedAt: new Date().toISOString() },
    scope: oauthReq.scope ?? [],
    // Binds the grant to the current connection password; see grant.ts.
    props: await grantProps(env.MCP_SECRET),
  });
  // Secret-free evidence that the redirect was emitted, so a stuck client can
  // be told apart from a server that never issued the code. The code and the
  // state value are never logged.
  const redirectUrl = new URL(redirectTo);
  console.log("authorize: redirect issued", {
    host: redirectUrl.host,
    hasState: redirectUrl.searchParams.has("state"),
    hasIss: redirectUrl.searchParams.has("iss"),
  });
  return Response.redirect(redirectTo, 302);
}
