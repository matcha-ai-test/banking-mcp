import type { AccountRow } from "./types";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store only a short, irreversible client bucket for rate limiting. */
export async function rateLimitKey(request: Request, action: string): Promise<string> {
  const client = request.headers.get("CF-Connecting-IP") ?? "local";
  return `${action}:${(await sha256Hex(client)).slice(0, 16)}`;
}

/**
 * Signed integer cents from a bank's unsigned-magnitude convention: negative
 * for money out (DBIT), positive for money in (CRDT). Stored amount_cents is
 * treated as magnitude-only (Math.abs) so a bank that already stored a
 * negative DBIT amount doesn't get double-negated.
 */
export function signedAmountCents(amountCents: number, creditDebit: string): number {
  return creditDebit === "DBIT" ? -Math.abs(amountCents) : Math.abs(amountCents);
}

/** Opaque stable account reference (account_identities.id): 32 lowercase hex chars. */
export const ACCOUNT_REF_RE = /^[0-9a-f]{32}$/;
/** transactionKey output shape: sha256Hex is 64 lowercase hex chars. */
export const TRANSACTION_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Match an account by uid, name, bank, label, the opaque account_ref, or the
 * full IBAN / last four digits (what list_accounts shows). Arbitrary IBAN
 * substrings are deliberately not matched: a client that only sees a masked
 * IBAN could otherwise reconstruct it character by character from "No
 * account matches" answers.
 *
 * A label or account_ref is an exact, deliberately-chosen selector, so it
 * takes precedence: if the filter exactly matches a label (case-insensitive)
 * or an account_ref, only the row(s) sharing that identity are returned —
 * never unioned with a same-string name/bank/IBAN hit on an unrelated
 * account. Otherwise, fall back to the broader substring/uid/bank/IBAN match.
 *
 * account_ref outranks label: a raw string that is shaped like an
 * account_ref and actually matches one identity's account_identity_id wins
 * outright, even if some other identity happens to carry that same string as
 * its label (set_account_label rejects such a label at write time, but a
 * value forced into the DB by another path must still resolve unambiguously
 * here). Only when no account_ref matches does a label match apply.
 *
 * Returns null when no filter was given, otherwise the matching uids.
 */
export function matchAccountUids(
  rows: Array<AccountRow & { aspsp_name: string | null; label?: string | null; account_identity_id?: string | null }>,
  account?: string
): string[] | null {
  const raw = (account ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const normalizedRaw = normalizeText(raw).toLowerCase();
  const digits = lower.replace(/[^a-z0-9]/g, "");

  if (ACCOUNT_REF_RE.test(raw)) {
    const refHits = rows.filter((a) => a.account_identity_id === raw);
    if (refHits.length > 0) return refHits.map((a) => a.account_uid);
  }

  const labelHits = rows.filter((a) => a.label != null && normalizeText(a.label).toLowerCase() === normalizedRaw);
  if (labelHits.length > 0) return labelHits.map((a) => a.account_uid);

  const hits = rows.filter((a) => {
    const iban = (a.iban ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const ibanHit =
      iban.length > 0 && digits.length >= 4 && (iban === digits || (digits.length === 4 && iban.endsWith(digits)));
    return (
      a.account_uid === raw ||
      ibanHit ||
      (a.name ?? "").toLowerCase().includes(lower) ||
      (a.aspsp_name ?? "").toLowerCase() === lower
    );
  });
  return hits.map((a) => a.account_uid);
}

/**
 * NFKC-normalize, drop invisible characters (format controls such as U+200B
 * and every other default-ignorable code point, e.g. U+3164 HANGUL FILLER),
 * trim, and collapse internal whitespace runs to a single space. A label made
 * only of invisible characters therefore normalizes to "" and fails the
 * length check, and two labels that render identically compare equal.
 */
export function normalizeText(v: string): string {
  return v
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Heuristic screen for text that looks like it might contain an IBAN, used to
 * reject user-supplied strings (labels, category names, rule patterns) before
 * they are persisted. False positives on random alphanumerics are acceptable
 * for a 60-256 character field; the value itself is never echoed back on a hit.
 */
export function containsIbanLike(text: string): boolean {
  const compact = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return /[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}/.test(compact);
}

/** Keep account identifiers useful without returning the full IBAN by default. */
export function maskIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const compact = iban.replace(/\s/g, "");
  return compact.length <= 4 ? compact : `•••• ${compact.slice(-4)}`;
}

/**
 * Timing-safe secret comparison. Both values are SHA-256-hashed first so the
 * compared buffers always have equal length (raw timingSafeEqual throws on
 * length mismatch, which itself leaks length information).
 */
export async function secretsMatch(presented: string | null | undefined, expected: string | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const AUTH_COOKIE_NAME = "banking_auth";
export const AUTH_COOKIE_TTL_MS = 30 * 60_000;

async function authCookieMac(expiresAtMs: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`auth-cookie:${expiresAtMs}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The operator link carries the token in the URL fragment, which never reaches
 * the server. The browser exchanges it once over POST for this short-lived
 * HMAC-signed cookie, so the token never appears in a request URL that
 * Cloudflare's invocation logs would record.
 */
export async function mintAuthCookie(secret: string, nowMs = Date.now()): Promise<string> {
  const expiresAtMs = nowMs + AUTH_COOKIE_TTL_MS;
  return `${expiresAtMs}.${await authCookieMac(expiresAtMs, secret)}`;
}

export async function verifyAuthCookie(value: string | null | undefined, secret: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!value || !secret) return false;
  const [expiryPart, macPart] = value.split(".");
  const expiresAtMs = Number(expiryPart);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < nowMs || !macPart) return false;
  return secretsMatch(macPart, await authCookieMac(expiresAtMs, secret));
}

export function cookieFrom(request: Request, name: string): string | null {
  const match = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function bearerFrom(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * claude.ai reserves `Authorization` in its custom connector header picker, so
 * a "No sign-in" connector cannot send a bearer token. These are the names it
 * offers instead, and the connection password may arrive in any of them.
 */
const API_KEY_HEADERS = [
  "x-api-key",
  "api-key",
  "apikey",
  "x-apikey",
  "x-api-token",
  "api-token",
  "x-auth-token",
] as const;

/** The first non-empty API key header, or null when none carries a value. */
export function apiKeyFrom(request: Request): string | null {
  for (const name of API_KEY_HEADERS) {
    const trimmed = (request.headers.get(name) ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Every credential the request carries, bearer first. A client can send both:
 * claude.ai keeps a stale OAuth bearer alongside a freshly configured API key
 * header, so the gate has to consider each candidate rather than only the first.
 */
export function presentedSecrets(request: Request): string[] {
  return [bearerFrom(request), apiKeyFrom(request)].filter((v): v is string => Boolean(v));
}

/**
 * What the /mcp shared-secret gate should do with a request.
 *
 * - "allow": a presented credential matches MCP_SECRET.
 * - "reject": an API key header was presented, no Authorization bearer was, and
 *   nothing matched. The caller answers 401 with a plain body and no
 *   WWW-Authenticate, so a claude.ai "No sign-in" connector reports a wrong
 *   password instead of turning a typo into an OAuth sign-in loop.
 * - "oauth": hand the request to the OAuth provider. This covers a request with
 *   no credentials at all and every request carrying a bearer, which is how a
 *   real OAuth client presents its access token: only the provider can tell a
 *   valid token from an invalid one, so a bearer that does not happen to be
 *   MCP_SECRET must never be rejected here.
 *
 * The bearer therefore decides which path a non-matching request takes. A
 * "No sign-in" connector cannot send `Authorization` at all, which is the whole
 * reason the API key headers exist, while claude.ai sends a Sign-in connector's
 * configured request headers alongside the OAuth bearer. Rejecting on the API
 * key header alone would mean a stale or mistyped `x-api-key` left on an OAuth
 * connector killed every OAuth request before the provider ever saw the token.
 */
export type McpGateDecision = "allow" | "reject" | "oauth";

export async function mcpGateDecision(request: Request, expected: string | undefined): Promise<McpGateDecision> {
  for (const candidate of presentedSecrets(request)) {
    if (await secretsMatch(candidate, expected)) return "allow";
  }
  return apiKeyFrom(request) && !bearerFrom(request) ? "reject" : "oauth";
}

/** 401 for a presented-but-wrong connection password. Deliberately carries no WWW-Authenticate. */
export function wrongPasswordResponse(): Response {
  return new Response("Wrong connection password", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number, from = new Date()): string {
  return isoDate(new Date(from.getTime() - n * 86400_000));
}
