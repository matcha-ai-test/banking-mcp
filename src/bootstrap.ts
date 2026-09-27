import { backfillAccountIdentities } from "./identity";
import { Db } from "./db";
import { migrate } from "./migrate";
import type { Env } from "./types";

const BACKFILL_THROTTLE_MS = 5 * 60_000;

/**
 * Module-level (per-isolate) throttle: the identity backfill runs at most
 * once per BACKFILL_THROTTLE_MS. A run that throws, or reports errors > 0,
 * does not update lastRunMs, so the next call retries immediately rather than
 * waiting out the window.
 */
let lastRunMs: number | null = null;

/** Test-only: reset the throttle between isolated test cases. Never called from
 * production code paths. */
export function __resetIdentityBackfillForTests(): void {
  lastRunMs = null;
}

/** Runs the identity backfill at most once per 5 minutes per isolate; a no-op
 * (no DB work) otherwise. Best-effort: never throws, so it never blocks the
 * caller. */
export async function ensureIdentityBackfill(env: Env): Promise<void> {
  const now = Date.now();
  if (lastRunMs !== null && now - lastRunMs < BACKFILL_THROTTLE_MS) return;
  try {
    const result = await backfillAccountIdentities(new Db(env));
    if (result.errors === 0) lastRunMs = now;
  } catch (error) {
    // Backfill is best-effort and must never block startup; migrate() failures
    // still propagate from initializeStorage. Log the error's name only, never
    // its message.
    console.warn("backfillAccountIdentities failed", (error as Error)?.name);
  }
}

/**
 * Per-isolate migration memo, shared by the Worker fetch/scheduled path
 * (index.ts) and the MCP Durable Object's init (mcp.ts), so an isolate that
 * serves both runs the ~11 idempotent statements once instead of once per
 * entry point and once per Durable Object start. A failed run is forgotten, so
 * the next caller retries instead of the isolate being poisoned. Every
 * deployment binds exactly one D1 database, which is what makes a single memo
 * per isolate correct.
 */
let migrated: Promise<void> | null = null;

export function ensureMigrated(env: Env): Promise<void> {
  migrated ??= migrate(env.DB).catch((e) => {
    migrated = null;
    throw e;
  });
  return migrated;
}

/** Test-only: forget the migration memo so a test can point initializeStorage
 * at a different (for example broken) database. Never called from production. */
export function __resetStorageInitForTests(): void {
  migrated = null;
}

/** Single initialization path: migrate the schema, then backfill any account
 * rows that still lack a stable-identity pointer (idempotent, cheap, retried
 * on later calls while not yet done). */
export async function initializeStorage(env: Env): Promise<void> {
  await ensureMigrated(env);
  await ensureIdentityBackfill(env);
}
