import { OAuthError } from "@cloudflare/workers-oauth-provider";
import { checkGrantProps, grantProps, staleGrantResponse } from "./grant";
import type { Env } from "./types";

// Kept apart from grant.ts: the provider package pulls in cloudflare:workers,
// which oauth.ts (and its tests) must not depend on just to mint grant props.

type FetchHandler = { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };

let legacyGrantWarned = false;

/**
 * Wraps the OAuth provider's apiHandler. The provider has already validated
 * the bearer and put the grant's props in ctx.props; a grant approved under a
 * previous MCP_SECRET is answered like an invalid token so the client signs in
 * again. Legacy grants pass, with one warning per isolate.
 */
export function guardedApiHandler(inner: FetchHandler): FetchHandler {
  return {
    async fetch(request, env, ctx) {
      const check = await checkGrantProps((ctx as ExecutionContext & { props?: unknown }).props, env.MCP_SECRET);
      if (check === "mismatch") return staleGrantResponse(request);
      if (check === "legacy" && !legacyGrantWarned) {
        legacyGrantWarned = true;
        console.warn("oauth: grant without a password fingerprint accepted (issued before rotation binding)");
      }
      return inner.fetch(request, env, ctx);
    },
  };
}

/**
 * tokenExchangeCallback: refresh honours the same binding as /mcp. A grant
 * approved under an old MCP_SECRET cannot mint new tokens, and a legacy grant
 * is stamped with the current fingerprint, after which a rotation revokes it
 * too. The provider's callback gets no env, so index.ts builds one provider
 * per env object.
 */
export function refreshGrantCheck(env: Pick<Env, "MCP_SECRET">) {
  return async (options: { grantType: string; props: unknown }) => {
    if (options.grantType !== "refresh_token") return;
    const check = await checkGrantProps(options.props, env.MCP_SECRET);
    if (check === "mismatch") {
      throw new OAuthError("invalid_grant", { description: "Grant was approved under a previous connection password" });
    }
    if (check === "legacy" && env.MCP_SECRET) {
      return { newProps: { ...(options.props as object), ...(await grantProps(env.MCP_SECRET)) } };
    }
  };
}
