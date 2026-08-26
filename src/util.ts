export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store only a short, irreversible client bucket for rate limiting. */
export async function rateLimitKey(request: Request, action: string): Promise<string> {
  const client = request.headers.get("CF-Connecting-IP") ?? "local";
  return `${action}:${(await sha256Hex(client)).slice(0, 16)}`;
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

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400_000);
}
