import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { handleAuthCallback, handleAuthSession, handleAuthStart } from "./auth";
import { BankingMCP } from "./mcp";
import { migrate } from "./migrate";
import { handleAuthorize } from "./oauth";
import { homePage, privacyPage, termsPage } from "./pages";
import { isConfigured } from "./settings";
import { syncAll } from "./sync";
import type { Env } from "./types";
import { bearerFrom, secretsMatch } from "./util";

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
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const resolved = await resolve(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (
      path === "/" ||
      path === "/privacy" ||
      path === "/terms" ||
      path === "/auth/start" ||
      path === "/auth/session" ||
      path === "/auth/callback"
    ) {
      return defaultHandler.fetch(request, resolved, ctx);
    }

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      if (!isConfigured(resolved)) {
        return new Response("Not configured. Run npm run install:mcp from the repository.", { status: 503 });
      }
      const bearer = bearerFrom(request);
      if (bearer && (await secretsMatch(bearer, resolved.MCP_SECRET))) {
        return mcpHandler.fetch(request, resolved, ctx);
      }
    }

    return oauthProvider.fetch(request, resolved as never, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const resolved = await resolve(env);
        if (!isConfigured(resolved)) return;
        const summary = await syncAll(resolved, "cron");
        console.log("cron sync:", JSON.stringify(summary));
      })()
    );
  },
};
