import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { refreshAspspCache } from "./aspsps";
import { handleAuthCallback, handleAuthSession, handleAuthStart } from "./auth";
import { Db } from "./db";
import { EbClient } from "./eb";
import { BankingMCP } from "./mcp";
import { migrate } from "./migrate";
import { handleAuthorize } from "./oauth";
import { homePage, privacyPage, termsPage } from "./pages";
import { isConfigured } from "./settings";
import { enrichmentPolicyFromEnv, syncAll } from "./sync";
import type { Env } from "./types";
import { mcpGateDecision, wrongPasswordResponse } from "./util";

export { BankingMCP };

const mcpHandler = BankingMCP.serve("/mcp", { binding: "MCP_OBJECT" });

// The migration is idempotent, but it is ~11 D1 statements; run it once per
// isolate rather than on every request. A failed run is forgotten so the next
// request retries instead of poisoning the isolate.
let migrated: Promise<void> | null = null;
async function resolve(env: Env): Promise<Env> {
  migrated ??= migrate(env.DB).catch((e) => {
    migrated = null;
    throw e;
  });
  await migrated;
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
        if (!isConfigured(env)) return new Response("Not configured. Run npm run install:mcp from the repository.", { status: 503 });
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

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as never,
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
});

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

      if (path === "/mcp" || path.startsWith("/mcp/")) {
        if (!isConfigured(resolved)) {
          return new Response("Not configured. Run npm run install:mcp from the repository.", { status: 503 });
        }
        // Bearer for Codex and CLI clients, an API key header for claude.ai
        // "No sign-in" connectors (which reserve Authorization). Both are
        // compared timing-safely against MCP_SECRET.
        const decision = await mcpGateDecision(request, resolved.MCP_SECRET);
        if (decision === "allow") return await mcpHandler.fetch(request, resolved, ctx);
        if (decision === "reject") return wrongPasswordResponse();
      }

      return await oauthProvider.fetch(request, resolved as never, ctx);
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
