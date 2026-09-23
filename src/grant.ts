import { sha256Hex } from "./util";

/**
 * OAuth grants are bound to the connection password that approved them.
 *
 * At approval the grant's props carry `secretFp`, a 64-bit truncated,
 * domain-separated SHA-256 of MCP_SECRET. Every OAuth-authenticated /mcp
 * request and every token refresh compares it against the current secret, so
 * rotating MCP_SECRET revokes the grants approved under the old one. The
 * fingerprint is never compared with the presented credential and reveals
 * nothing about the secret beyond a 64-bit hash of a high-entropy value.
 *
 * Grants issued before this check existed have no `secretFp`; they are still
 * accepted (a rotation would otherwise disconnect every live connector at
 * deploy time) and are stamped with the current fingerprint at their next
 * token refresh, after which a rotation revokes them too. `npm run
 * oauth:revoke` removes every grant immediately.
 */
const GRANT_FP_DOMAIN = "banking-mcp/grant-fp/v1:";

export async function grantFingerprint(secret: string): Promise<string> {
  return (await sha256Hex(GRANT_FP_DOMAIN + secret)).slice(0, 16);
}

export type GrantCheck = "match" | "legacy" | "mismatch";

/** Props stored with a grant; `secretFp` is absent on grants issued before B1. */
export interface GrantProps {
  user?: string;
  secretFp?: string;
}

export async function grantProps(secret: string): Promise<GrantProps> {
  return { user: "operator", secretFp: await grantFingerprint(secret) };
}

/**
 * "match" when the stored fingerprint equals the current secret's, "legacy"
 * when the grant predates fingerprints, "mismatch" otherwise (including when
 * no secret is configured at all: nothing can be verified, so nothing passes).
 */
export async function checkGrantProps(props: unknown, secret: string | undefined): Promise<GrantCheck> {
  const fp = props && typeof props === "object" ? (props as GrantProps).secretFp : undefined;
  if (fp === undefined || fp === null) return "legacy";
  if (typeof fp !== "string" || !secret) return "mismatch";
  return fp === (await grantFingerprint(secret)) ? "match" : "mismatch";
}

/**
 * 401 in the exact shape workers-oauth-provider uses for an invalid access
 * token: JSON body plus an RFC 6750 challenge with `error="invalid_token"`,
 * which is what makes claude.ai and the MCP SDK clients start a fresh sign-in.
 */
export function staleGrantResponse(request: Request): Response {
  const url = new URL(request.url);
  const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: "Access token was approved under a previous connection password; sign in again" }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", error="invalid_token"`,
      },
    }
  );
}
