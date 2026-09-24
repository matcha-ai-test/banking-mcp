import type { Db } from "./db";
import type { AccountRow, PsuType } from "./types";
import { sha256Hex } from "./util";

export interface NaturalIdentity {
  iban: string | null;
  identificationHash: string | null;
  currency: string;
  psuType: PsuType;
}

export type IdentityResolution =
  | { ok: true; id: string; created: boolean }
  | { ok: false; reason: "identity_conflict" | "stable_identity_unavailable" | "transient_error" };

export function canonicalIban(v: string | null | undefined): string | null {
  if (v == null) return null;
  const compact = v.replace(/\s/g, "").toUpperCase();
  return /^[A-Z0-9]{5,34}$/.test(compact) ? compact : null;
}

export function canonicalCurrency(v: string | null | undefined): string {
  const compact = (v ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(compact) ? compact : "";
}

export function naturalIdentityOf(
  a: Pick<AccountRow, "iban" | "identification_hash" | "currency" | "psu_type">
): NaturalIdentity | null {
  const iban = canonicalIban(a.iban);
  const identificationHash =
    typeof a.identification_hash === "string" && a.identification_hash.length > 0 && a.identification_hash.length <= 2048
      ? a.identification_hash
      : null;
  if (iban === null && identificationHash === null) return null;
  return { iban, identificationHash, currency: canonicalCurrency(a.currency), psuType: a.psu_type };
}

/**
 * Resolve (or create) the registry identity for a natural identity. Fails
 * closed: any disagreement between an IBAN match and a hash match, or a
 * unique-index collision on attach, returns identity_conflict rather than
 * guessing. See FABLE spec 0.E.
 */
export async function resolveAccountIdentity(db: Db, n: NaturalIdentity): Promise<IdentityResolution> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const byIban = n.iban ? await db.identityByIban(n.iban, n.currency, n.psuType) : null;
    const byHash = n.identificationHash ? await db.identityByHash(n.identificationHash, n.currency, n.psuType) : null;

    // The hash points at an identity with a different IBAN: two accounts disagree.
    if (byHash && n.iban && byHash.iban && byHash.iban !== n.iban) {
      return { ok: false, reason: "identity_conflict" };
    }
    // IBAN is authoritative. A hash that belongs to another, hash-only identity
    // does not discard a confirmed IBAN match; that hash is just not attached.
    if (byIban && byHash && byIban.id !== byHash.id) {
      return { ok: true, id: byIban.id, created: false };
    }

    const found = byIban ?? byHash;
    if (found) {
      // The incoming row has no IBAN but matched purely by hash onto an
      // identity that already carries an IBAN. That identity is not
      // necessarily this account's: fail closed rather than silently
      // pointing a hash-only row at an IBAN-bearing identity or folding the
      // two. No pointer is set and nothing is attached.
      if (!n.iban && found.iban !== null) {
        return { ok: false, reason: "identity_conflict" };
      }
      // Symmetric case: the incoming row HAS an IBAN, but the identity was
      // found only by hash (byIban null, found.iban null) — the identity is
      // not necessarily this account's IBAN-bearing account either. Fail
      // closed rather than attaching the IBAN to a hash-only identity. This
      // is the only way found.iban can be null while n.iban is set: when
      // byIban is truthy, found === byIban and its iban column already
      // equals n.iban (that is how it was found), so it is never null here.
      if (n.iban && found.iban === null) {
        return { ok: false, reason: "identity_conflict" };
      }
      if (n.identificationHash && found.identification_hash === null) {
        const attached = await db.attachIdentityHash(found.id, n.identificationHash);
        if (!attached) {
          const current = await db.identityById(found.id);
          // Lost the attach race or the hash is owned elsewhere: an IBAN match still stands.
          if (current?.identification_hash !== n.identificationHash && !byIban) return { ok: false, reason: "identity_conflict" };
        }
      }
      return { ok: true, id: found.id, created: false };
    }

    const id = crypto.randomUUID().replaceAll("-", "");
    const inserted = await db.insertIdentityIgnore({
      id,
      iban: n.iban,
      identification_hash: n.identificationHash,
      currency: n.currency,
      psu_type: n.psuType,
    });
    if (inserted) return { ok: true, id, created: true };
    // A concurrent creator won the unique index; retry once by re-reading.
  }
  // Both attempts failed to insert, yet the re-read at the top of the retry
  // never found a row either (a genuine concurrent winner would have been
  // found and returned above). That combination means the insert itself is
  // failing transiently, not that two identities genuinely disagree — so this
  // is transient_error, not identity_conflict, and callers (assignAccountIdentities,
  // ensureIdentityBackfill) must retry it rather than treat it as resolved.
  return { ok: false, reason: "transient_error" };
}

/**
 * Key of the natural identity a conflict was recorded for. A row whose inputs
 * (IBAN, hash, currency, PSU type) are unchanged since its last fail-closed
 * resolution is not retried: the answer cannot change until either the bank
 * reports different inputs or the operator resolves it. Transient errors are
 * never recorded and always retry.
 */
export async function conflictKeyOf(n: NaturalIdentity): Promise<string> {
  return (await sha256Hex(JSON.stringify(["identity-conflict-v1", n.iban, n.identificationHash, n.currency, n.psuType]))).slice(0, 32);
}

async function recordConflict(db: Db, uid: string, n: NaturalIdentity): Promise<void> {
  try {
    await db.markIdentityConflict(uid, await conflictKeyOf(n));
  } catch {
    // Best effort: an unrecorded conflict is simply retried next cycle.
  }
}

export async function assignAccountIdentities(db: Db, accounts: AccountRow[]): Promise<Map<string, IdentityResolution>> {
  const out = new Map<string, IdentityResolution>();
  let assigned = 0;
  let conflicts = 0;
  let unavailable = 0;
  let errors = 0;
  for (const row of accounts) {
    const n = naturalIdentityOf(row);
    if (n === null) {
      out.set(row.account_uid, { ok: false, reason: "stable_identity_unavailable" });
      unavailable++;
      continue;
    }
    try {
      const res = await resolveAccountIdentity(db, n);
      if (!res.ok) {
        out.set(row.account_uid, res);
        if (res.reason === "identity_conflict") {
          conflicts++;
          await recordConflict(db, row.account_uid, n);
        }
        else if (res.reason === "transient_error") errors++;
        else unavailable++;
        continue;
      }
      await db.setAccountIdentityIfNull(row.account_uid, res.id);
      const verified = await db.verifyAccountIdentity(row.account_uid, res.id);
      if (!verified) {
        out.set(row.account_uid, { ok: false, reason: "identity_conflict" });
        conflicts++;
        continue;
      }
      out.set(row.account_uid, res);
      assigned++;
    } catch {
      // Never let one row's failure abort the batch, and never log identifiers
      // or error text that might contain values. A thrown error is transient
      // (e.g. a flaky D1 write) rather than a real disagreement between two
      // identities, so it is reported distinctly and must not be treated as
      // identity_conflict by callers — see auth.ts, which skips folding for
      // both reasons alike, and bootstrap.ts, which retries on it.
      out.set(row.account_uid, { ok: false, reason: "transient_error" });
      errors++;
    }
  }
  // Nearly every call finds nothing to do; only a run that did something is worth a log line.
  if (assigned + conflicts + unavailable + errors > 0) {
    console.log("identity assignment", { assigned, conflicts, unavailable, errors });
  }
  return out;
}

export async function backfillAccountIdentities(db: Db): Promise<{ assigned: number; conflicts: number; unavailable: number; errors: number }> {
  const pending = await db.accountsWithoutIdentity();
  const rows: AccountRow[] = [];
  for (const row of pending) {
    const n = naturalIdentityOf(row);
    if (n && row.identity_conflict_key && row.identity_conflict_key === (await conflictKeyOf(n))) continue;
    rows.push(row);
  }
  const results = await assignAccountIdentities(db, rows);
  let assigned = 0;
  let conflicts = 0;
  let unavailable = 0;
  let errors = 0;
  for (const res of results.values()) {
    if (res.ok) assigned++;
    else if (res.reason === "identity_conflict") conflicts++;
    else if (res.reason === "transient_error") errors++;
    else unavailable++;
  }
  return { assigned, conflicts, unavailable, errors };
}

export async function transactionKey(dedupKey: string): Promise<string> {
  return sha256Hex(JSON.stringify(["category-tx-v1", dedupKey]));
}
