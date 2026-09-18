import type { Db } from "./db";
import type { Aspsp } from "./eb";
import type { AspspRow } from "./types";

/** The bank list changes rarely; a week keeps the nightly cron from spending a call every night. */
export const ASPSP_CACHE_TTL_MS = 7 * 86400_000;

export function aspspRows(aspsps: Aspsp[], fetchedAt = new Date().toISOString()): AspspRow[] {
  return aspsps
    .filter((a) => typeof a.name === "string" && typeof a.country === "string")
    .map((a) => ({
      name: a.name,
      country: a.country.toUpperCase(),
      psu_types: a.psu_types?.length ? a.psu_types.join(",") : null,
      maximum_consent_validity: typeof a.maximum_consent_validity === "number" ? a.maximum_consent_validity : null,
      fetched_at: fetchedAt,
    }));
}

/**
 * Refresh the bank list when the cache is older than the TTL. This is an
 * Enable Banking directory call, not a bank (ASPSP) call, so it costs no
 * per-session refresh budget. Failures are logged and swallowed: the list is
 * a convenience for list_banks, never a prerequisite for a sync.
 */
export async function refreshAspspCache(db: Db, getAspsps: () => Promise<Aspsp[]>, nowMs = Date.now()): Promise<boolean> {
  const fetchedAt = await db.aspspCacheFetchedAt();
  if (fetchedAt && nowMs - new Date(fetchedAt).getTime() < ASPSP_CACHE_TTL_MS) return false;
  try {
    await db.upsertAspsps(aspspRows(await getAspsps(), new Date(nowMs).toISOString()));
    return true;
  } catch (e) {
    console.warn("ASPSP cache refresh failed", { name: (e as Error).name });
    return false;
  }
}
