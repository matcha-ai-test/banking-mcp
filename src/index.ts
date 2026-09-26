import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { refreshAspspCache } from "./aspsps";
import { handleAuthCallback, handleAuthSession, handleAuthStart, STATE_TTL_MINUTES } from "./auth";
import { initializeStorage } from "./bootstrap";
import { Db } from "./db";
import { EbClient } from "./eb";
import { guardedApiHandler, refreshGrantCheck } from "./grant-guard";
import { BankingMCP } from "./mcp";
import { handleAuthorize } from "./oauth";
import { homePage, privacyPage, termsPage } from "./pages";
import { isConfigured } from "./settings";
import { enrichmentPolicyFromEnv, syncAll } from "./sync";
import type { Env } from "./types";
import { bearerFrom, mcpGateDecision, rateLimitKey, wrongPasswordResponse } from "./util";

export { BankingMCP };

const mcpHandler = BankingMCP.serve("/mcp", { binding: "MCP_OBJECT" });

// Migration runs once per isolate (memoized in bootstrap.ts and shared with the
// MCP Durable Object's init); the identity backfill has its own success-keyed
// throttle there, so a not-yet-done backfill is never stuck behind the memo.
async function resolve(env: Env): Promise<Env> {
  await initializeStorage(env);
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

const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const CLIENT_REGISTRATION_TTL_SECONDS = 365 * 24 * 60 * 60;

function createOAuthProvider(env: Env): OAuthProvider {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: oauthApiHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // The library defaults to a 30-day refresh token lifetime counted from the
    // first sign-in (refreshing does not extend it), so every connector had to
    // be re-authorized each month. Match the bank consent instead (~180 days),
    // and keep the client registration (default 90 days) alive at least as long.
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
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

/**
 * Failed /mcp credential attempts allowed per client bucket per window. A wrong
 * API key header and a bearer the OAuth provider rejects count against the same
 * bucket, so switching headers does not buy an attacker more guesses.
 */
const MCP_FAILURES_PER_WINDOW = 20;
const MCP_FAILURE_WINDOW_MS = 10 * 60_000;

/** Dynamic client registrations allowed per client bucket per hour. */
const REGISTRATIONS_PER_HOUR = 10;

/** Counts one failed /mcp credential; false once the client's bucket is exhausted. */
async function mcpFailureAllowed(request: Request, env: Env): Promise<boolean> {
  const key = await rateLimitKey(request, "mcp-secret-fail");
  return new Db(env).rateLimitOk(key, MCP_FAILURES_PER_WINDOW, MCP_FAILURE_WINDOW_MS);
}

function tooManyAttempts(): Response {
  return new Response("Too many attempts", {
    status: 429,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "600" },
  });
}

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
          if (!(await mcpFailureAllowed(request, resolved))) return tooManyAttempts();
          return wrongPasswordResponse();
        }
        // A bearer that is not MCP_SECRET goes to the OAuth provider, which alone
        // can tell a real access token from a guess. A 401 there is a failed
        // credential like a wrong API key and is counted in the same bucket; a
        // request without any credential (the OAuth discovery 401) is not.
        const response = await oauthProviderFor(resolved).fetch(request, resolved as never, ctx);
        if (response.status === 401 && bearerFrom(request) !== null) {
          if (!(await mcpFailureAllowed(request, resolved))) return tooManyAttempts();
        }
        return response;
      }

      if (path === "/register") {
        const key = await rateLimitKey(request, "register");
        if (!(await new Db(resolved).rateLimitOk(key, REGISTRATIONS_PER_HOUR, 3_600_000))) {
          return Response.json(
            { error: "too_many_requests", error_description: "Too many client registrations. Try again later." },
            { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "3600" } }
          );
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
        // Housekeeping first and best-effort: it must never block the sync.
        try {
          const pruned = await new Db(resolved).pruneEphemeralRows(STATE_TTL_MINUTES);
          console.log("cron: pruned", JSON.stringify(pruned));
        } catch (e) {
          console.warn("cron: prune failed", (e as Error)?.name);
        }
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
