/** Public URL of this instance. Set by setup / wrangler vars. */
export function getBaseUrl(env: { BASE_URL?: string }, fallback = ""): string {
  return String(env.BASE_URL || fallback).replace(/\/$/, "");
}
