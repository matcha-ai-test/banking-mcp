import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Db } from "./db";
import { esc, languageFromRequest, pageResponse } from "./pages";
import type { Env } from "./types";
import { rateLimitKey, secretsMatch } from "./util";

const AUTHORIZE_ATTEMPTS_PER_HOUR = 10;

function consentForm(request: Request, clientName: string, failed = false): Response {
  const lang = languageFromRequest(request);
  const body = lang === "sv"
    ? `<h1>Godkänn anslutningen till banking-mcp</h1><p>Klienten <code>${esc(clientName)}</code> begär <strong>skrivskyddad</strong> åtkomst till dina länkade bankuppgifter. banking-mcp har inga skrivfunktioner mot banken.</p>${failed ? '<p class="err" role="alert">Fel anslutningslösenord. Försök igen.</p>' : ""}<form method="POST" autocomplete="off"><input type="hidden" name="lang" value="sv"><label for="password">Anslutningslösenord</label><input id="password" type="password" name="password" autocomplete="current-password" autofocus required><div class="actions"><button type="submit">Godkänn</button></div></form><p class="hint">Bara den som driver installationen kan godkänna. Installationsskriptet sparar lösenordet i lokala <code>.dev.vars</code> eller som en krypterad Cloudflare Worker-hemlighet.</p>`
    : `<h1>Approve the banking-mcp connection</h1><p>Client <code>${esc(clientName)}</code> is asking for <strong>read-only</strong> access to your linked bank data. banking-mcp has no bank-side write functions.</p>${failed ? '<p class="err" role="alert">Wrong connection password. Try again.</p>' : ""}<form method="POST" autocomplete="off"><input type="hidden" name="lang" value="en"><label for="password">Connection password</label><input id="password" type="password" name="password" autocomplete="current-password" autofocus required><div class="actions"><button type="submit">Approve</button></div></form><p class="hint">Only the operator can approve. The installer stores this password in local <code>.dev.vars</code> or as an encrypted Cloudflare Worker secret.</p>`;
  return pageResponse({ title: lang === "sv" ? "Godkänn anslutning" : "Approve connection", body, lang, currentUrl: request.url, status: failed ? 401 : 200 });
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
  } catch {
    const lang = languageFromRequest(request);
    return pageResponse({ title: lang === "sv" ? "Ogiltig OAuth-begäran" : "Invalid OAuth request", body: lang === "sv" ? "<h1>Ogiltig OAuth-begäran</h1>" : "<h1>Invalid OAuth request</h1>", lang, currentUrl: request.url, status: 400 });
  }

  if (request.method === "GET") {
    return consentForm(request, oauthReq.clientId);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const db = new Db(env);
  if (!(await db.rateLimitOk(await rateLimitKey(request, "authorize"), AUTHORIZE_ATTEMPTS_PER_HOUR, 3600_000))) {
    const lang = languageFromRequest(request);
    return pageResponse({ title: lang === "sv" ? "För många försök" : "Too many attempts", body: lang === "sv" ? "<h1>För många försök</h1><p>Vänta en timme och försök igen.</p>" : "<h1>Too many attempts</h1><p>Wait an hour and try again.</p>", lang, currentUrl: request.url, status: 429 });
  }

  const form = await request.formData();
  const password = form.get("password")?.toString() ?? "";
  if (!(await secretsMatch(password, env.MCP_SECRET))) {
    return consentForm(request, oauthReq.clientId, true);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "operator",
    metadata: { approvedAt: new Date().toISOString() },
    scope: oauthReq.scope ?? [],
    props: { user: "operator" },
  });
  return Response.redirect(redirectTo, 302);
}
