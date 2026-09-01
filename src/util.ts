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
 * Match an account by uid, name, bank, the full IBAN, or its last four digits
 * (what list_accounts shows). Arbitrary IBAN substrings are deliberately not
 * matched: a client that only sees a masked IBAN could otherwise reconstruct
 * it character by character from "No account matches" answers.
 * Returns null when no filter was given, otherwise the matching uids.
 */
export function matchAccountUids(
  rows: Array<AccountRow & { aspsp_name: string | null }>,
  account?: string
): string[] | null {
  const raw = (account ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const digits = lower.replace(/[^a-z0-9]/g, "");
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

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number, from = new Date()): string {
  return isoDate(new Date(from.getTime() - n * 86400_000));
}
