import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { refreshAspspCache } from "./aspsps";
import { handleAuthCallback, handleAuthSession, handleAuthStart } from "./auth";
import { ensureIdentityBackfill } from "./bootstrap";
import { Db } from "./db";
import { EbClient } from "./eb";
import { guardedApiHandler, refreshGrantCheck } from "./grant-guard";
import { migrate } from "./migrate";
import { BankingMCP } from "./mcp";
import { handleAuthorize } from "./oauth";
import { homePage, privacyPage, termsPage } from "./pages";
import { isConfigured } from "./settings";
import { enrichmentPolicyFromEnv, syncAll } from "./sync";
import type { Env } from "./types";
import { mcpGateDecision, rateLimitKey, wrongPasswordResponse } from "./util";

export { BankingMCP };

const mcpHandler = BankingMCP.serve("/mcp", { binding: "MCP_OBJECT" });

// The migration is idempotent, but it is ~11 D1 statements; run it once per
// isolate rather than on every request. A failed run is forgotten so the next
// request retries instead of poisoning the isolate. The identity backfill is
// memoized separately (in bootstrap.ts, keyed on its own success) so a
// migrate-only memo here can never keep a not-yet-done backfill stuck behind
// a "success" memo: ensureIdentityBackfill is cheap (a no-op) once it has
// actually finished, and is safe to call on every request until then.
let migrated: Promise<void> | null = null;
async function resolve(env: Env): Promise<Env> {
  migrated ??= migrate(env.DB).catch((e) => {
    migrated = null;
    throw e;
  });
  await migrated;
  await ensureIdentityBackfill(env);
  return env;
}

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/privacy") return privacyPage();
      if (path === "/terms") return termsPage();
      if (path === "/") return homePage(isConfigured(env));
      if (path === "/auth/start") {
        if (!isConfigured(env)) return new Response(NOT_CONFIGURED, { status: 503 });
        return await handleAuthStart(request, env);
      }
      if (path === "/auth/session") {
        if (!isConfigured(env)) return new Response("Not found", { status: 404 });
        return await handleAuthSession(request, env);
      }
      if (path === "/auth/callback") return await handleAuthCallback(request, env);
      if (path === "/authorize") return await handleAuthorize(request, env as Parameters<typeof handleAuthorize>[1]);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error("Unhandled request error", { name: (e as Error).name });
      return new Response("Internal error", { status: 500 });
    }
  },
};

// OAuth-authenticated /mcp requests pass the grant binding check (grant.ts) first.
const oauthApiHandler = guardedApiHandler(mcpHandler);

function createOAuthProvider(env: Env): OAuthProvider {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: oauthApiHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // claude.ai's default client option "Use Claude's published identity" sends
    // an https URL as client_id. Without this the provider answers
    // "Invalid client_id" on every first connection attempt. The library
    // requires the global_fetch_strictly_public compatibility flag, which
    // wrangler.jsonc sets, before it advertises the capability.
    clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: refreshGrantCheck(env),
  });
}

const providers = new WeakMap<Env, OAuthProvider>();
function oauthProviderFor(env: Env): OAuthProvider {
  let provider = providers.get(env);
  if (!provider) {
    provider = createOAuthProvider(env);
    providers.set(env, provider);
  }
  return provider;
}

/** OAuth endpoints that must stay closed until real secrets are installed. */
const OAUTH_ENDPOINTS = new Set(["/authorize", "/token", "/register"]);
const NOT_CONFIGURED = "Not configured. Run npm run install:mcp from the repository.";

/** Failed /mcp connection-password attempts allowed per client bucket per window. */
const MCP_FAILURES_PER_WINDOW = 20;
const MCP_FAILURE_WINDOW_MS = 10 * 60_000;

/** Pages Enable Banking fetches during app registration; they must not need D1. */
const STATIC_PATHS = new Set(["/", "/privacy", "/terms"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Before resolve(): the migration touches D1, and Enable Banking fetches
      // /privacy and /terms while the application is being registered, which is
      // exactly when D1 may be missing or the migration may still fail.
      if (STATIC_PATHS.has(path)) {
        if (path === "/privacy") return privacyPage();
        if (path === "/terms") return termsPage();
        return homePage(isConfigured(env));
      }

      const resolved = await resolve(env);

      if (path === "/auth/start" || path === "/auth/session" || path === "/auth/callback") {
        // `return await` throughout: a bare `return` would settle the promise
        // outside this try, so a rejected handler would escape as a Worker
        // exception instead of the plain 500 below.
        return await defaultHandler.fetch(request, resolved, ctx);
      }

      // Discovery under /.well-known stays reachable: it is static metadata
      // and every endpoint it advertises answers 503 below until configured.
      if (OAUTH_ENDPOINTS.has(path) && !isConfigured(resolved)) {
        return new Response(NOT_CONFIGURED, { status: 503 });
      }

      if (path === "/mcp" || path.startsWith("/mcp/")) {
        if (!isConfigured(resolved)) {
          return new Response(NOT_CONFIGURED, { status: 503 });
        }
        // Bearer for Codex and CLI clients, an API key header for claude.ai
        // "No sign-in" connectors (which reserve Authorization). Both are
        // compared timing-safely against MCP_SECRET.
        const decision = await mcpGateDecision(request, resolved.MCP_SECRET);
        if (decision === "allow") return await mcpHandler.fetch(request, resolved, ctx);
        if (decision === "reject") {
          // Only failures are counted; a correct password never touches the limiter.
          const key = await rateLimitKey(request, "mcp-secret-fail");
          if (!(await new Db(resolved).rateLimitOk(key, MCP_FAILURES_PER_WINDOW, MCP_FAILURE_WINDOW_MS))) {
            return new Response("Too many attempts", {
              status: 429,
              headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "600" },
            });
          }
          return wrongPasswordResponse();
        }
      }

      return await oauthProviderFor(resolved).fetch(request, resolved as never, ctx);
    } catch (e) {
      console.error("Unhandled worker error", { name: (e as Error).name });
      return new Response("Internal error", { status: 500 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const resolved = await resolve(env);
        if (!isConfigured(resolved)) return;
        const policy = enrichmentPolicyFromEnv(resolved);
        const summary = await syncAll(resolved, "cron", {
          enrichBackfillDays: policy.enrichBackfillDays,
          enrichMaxPerAccount: policy.enrichMaxPerAccount,
          enrichMaxPerSession: policy.enrichMaxPerSession,
        });
        console.log("cron sync:", JSON.stringify(summary));
        // Directory call to Enable Banking, not to any bank: no refresh budget is spent.
        const refreshed = await refreshAspspCache(new Db(resolved), () => new EbClient(resolved).getAspsps());
        if (refreshed) console.log("cron: bank list cache refreshed");
      })()
    );
  },
};
