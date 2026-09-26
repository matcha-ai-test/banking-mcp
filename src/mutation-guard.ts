import type { Db } from "./db";

/** Shared write budget for every mutating tool: 30 mutations per rolling minute. */
export async function checkMutationBudget(db: Db): Promise<boolean> {
  return db.rateLimitOk("mcp_mutation", 30, 60_000);
}

/** UTF-8 byte length of the serialized tool arguments must stay under the cap. */
export function enforceArgBudget(args: unknown, maxBytes = 16384): boolean {
  const bytes = new TextEncoder().encode(JSON.stringify(args) ?? "").length;
  return bytes <= maxBytes;
}

/**
 * Fixed set of sanitized error codes for every new (mutating) tool. Never
 * paired with a D1 message, SQL text, or an echoed submitted value.
 */
export const ERROR_CODES = [
  "invalid_argument",
  "no_account_match",
  "ambiguous_account",
  "stable_identity_unavailable",
  "identity_conflict",
  "not_found",
  "label_collision",
  "name_collision",
  "revision_conflict",
  "idempotency_conflict",
  "cap_reached",
  "rate_limited",
  "text_looks_like_account_number",
  "too_many_candidates",
  "not_cached",
  "sink_not_configured",
  "sink_failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
