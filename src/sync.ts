import { Db } from "./db";
import { EbClient, ExpiredSessionError, RateLimitError } from "./eb";
import type { AccountRow, EbTransaction, Env, TxRow } from "./types";
import { daysAgo, isoDate, sha256Hex } from "./util";

const MAX_PAGES_PER_ACCOUNT = 80;
const OVERLAP_DAYS = 10;
const BACKOFF_HOURS = 6;
/** Conservative recommendations, not documented bank limits; all three are configurable per call and, for the
 * nightly cron, via the optional ENRICH_BACKFILL_DAYS / ENRICH_MAX_PER_ACCOUNT / ENRICH_MAX_PER_SESSION Worker vars. */
export const ENRICH_MAX_PER_ACCOUNT = 3;
export const ENRICH_MAX_PER_SESSION = 6;
export const ENRICH_BACKFILL_DAYS = 45;

interface EnrichmentBudget {
  remaining: number;
  stopped?: "rate_limited" | "expired";
}

function enrichmentLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Nightly cron enrichment policy from optional Worker vars; invalid or missing values fall back to the
 * conservative recommendations above, so an unconfigured deployment behaves exactly as before. */
export function enrichmentPolicyFromEnv(env: Env): {
  enrichBackfillDays: number;
  enrichMaxPerAccount: number;
  enrichMaxPerSession: number;
} {
  return {
    enrichBackfillDays: parseNonNegativeInt(env.ENRICH_BACKFILL_DAYS) ?? ENRICH_BACKFILL_DAYS,
    enrichMaxPerAccount: parseNonNegativeInt(env.ENRICH_MAX_PER_ACCOUNT) ?? ENRICH_MAX_PER_ACCOUNT,
    enrichMaxPerSession: parseNonNegativeInt(env.ENRICH_MAX_PER_SESSION) ?? ENRICH_MAX_PER_SESSION,
  };
}

function enrichmentCandidate(row: TxRow, holder: string | null): boolean {
  let raw;
  try { raw = JSON.parse(row.raw ?? "null"); } catch { return false; }
  if (!raw || typeof raw !== "object" || raw.detail != null || row.detail_fetched_at != null) return false;
  if (raw.remittance_information != null && (!Array.isArray(raw.remittance_information) ||
    !raw.remittance_information.every((value: unknown) => typeof value === "string"))) return false;
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  const text = normalize((raw.remittance_information ?? []).join(" "));
  return typeof raw.transaction_id === "string" && raw.transaction_id.trim() !== "" &&
    (text === "" || text === normalize(holder ?? "") || /^[0-9\s]+$/.test(text));
}

function toCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function counterpartyOf(t: EbTransaction): string | null {
  return (t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name) ?? null;
}

async function toRow(accountUid: string, t: EbTransaction): Promise<TxRow> {
  const booking = t.booking_date ?? t.value_date ?? t.transaction_date ?? isoDate(new Date());
  const remittance = (t.remittance_information ?? []).join(" ") || null;
  // Booked transactions usually carry a stable entry_reference; fall back to a
  // content hash only when it is missing.
  const dedup = t.entry_reference
    ? `er:${t.entry_reference}`
    : `h:${await sha256Hex([booking, t.transaction_amount.amount, t.transaction_amount.currency, t.credit_debit_indicator, remittance ?? "", t.value_date ?? ""].join("|"))}`;
  return {
    account_uid: accountUid,
    booking_date: booking,
    value_date: t.value_date ?? null,
    amount_cents: toCents(t.transaction_amount.amount),
    currency: t.transaction_amount.currency,
    credit_debit: t.credit_debit_indicator,
    counterparty: counterpartyOf(t),
    remittance_info: remittance,
    entry_reference: t.entry_reference ?? null,
    dedup_key: dedup,
    // Retain the list record for detail lookup; tool outputs remain sanitized.
    raw: JSON.stringify(t),
  };
}

/** Fetch all transaction pages for an account within a window. */
async function fetchWindow(
  db: Db,
  eb: EbClient,
  account: AccountRow,
  dateFrom: string,
  strategy?: "default" | "longest"
): Promise<{ booked: EbTransaction[]; pending: EbTransaction[] }> {
  const booked: EbTransaction[] = [];
  const pending: EbTransaction[] = [];
  let continuationKey: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    const res = await eb.getTransactions(account.account_uid, { dateFrom, continuationKey, strategy });
    await db.setSessionLiveOk(account.session_pk);
    for (const t of res.transactions ?? []) {
      if ((t.status ?? "BOOK") === "BOOK") booked.push(t);
      else pending.push(t);
    }
    if (!res.continuation_key) break;
    continuationKey = res.continuation_key;
  }
  return { booked, pending };
}

export interface AccountSyncResult {
  account_uid: string;
  new_transactions: number;
  pending: number;
  details_fetched: number;
  details_failed: number;
  error?: string;
}

/** Reconciliation sync for one account: overlapping window, idempotent upsert. */
export async function syncAccount(
  db: Db,
  eb: EbClient,
  account: AccountRow,
  opts: {
    dateFrom?: string;
    strategy?: "default" | "longest";
    /** Overrides both the per-account and per-session caps with the same limit; 0 disables detail calls. */
    enrichMax?: number;
    /** Per-account cap when enrichMax is not set (used by the cron env policy). */
    enrichMaxPerAccount?: number;
    /** Initial per-session budget when enrichMax and enrichmentBudget are not set (used by the cron env policy). */
    enrichMaxPerSession?: number;
    enrichBackfillDays?: number;
    enrichmentBudget?: EnrichmentBudget;
  } = {}
): Promise<AccountSyncResult> {
  const dateFrom =
    opts.dateFrom ??
    (account.last_synced_at ? daysAgo(OVERLAP_DAYS, new Date(account.last_synced_at + "Z")) : daysAgo(90));

  const { booked, pending } = await fetchWindow(db, eb, account, dateFrom, opts.strategy);

  const insertedRows: Array<TxRow & { id: number }> = [];
  let inserted = 0;
  if (booked.length > 0) {
    const rows = await Promise.all(booked.map((t) => toRow(account.account_uid, t)));
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.dedup_key) ? false : (seen.add(r.dedup_key), true)));
    inserted = await db.insertTransactionsIgnore(unique, insertedRows);
  }

  // New rows take priority over cached candidates; each group is newest first.
  const candidates = insertedRows.filter((row) => enrichmentCandidate(row, account.name))
    .sort((a, b) => b.booking_date.localeCompare(a.booking_date));
  const accountLimit = enrichmentLimit(opts.enrichMax ?? opts.enrichMaxPerAccount, ENRICH_MAX_PER_ACCOUNT);
  const backfillDays = enrichmentLimit(opts.enrichBackfillDays, ENRICH_BACKFILL_DAYS);
  if (backfillDays > 0 && accountLimit > 0 && !opts.enrichmentBudget?.stopped &&
    (opts.enrichmentBudget?.remaining ?? 1) > 0) {
    const seenIds = new Set(candidates.map((row) => row.id));
    const backfill = await db.enrichmentBackfillCandidates(account.account_uid, daysAgo(backfillDays));
    for (const row of backfill) {
      if (!seenIds.has(row.id) && enrichmentCandidate(row, account.name)) {
        seenIds.add(row.id);
        candidates.push(row);
      }
    }
  }

  // Pending: no history kept — truncate & rewrite per account (entry_reference is unstable pre-booking)
  const pendingRows = await Promise.all(pending.map((t) => toRow(account.account_uid, t)));
  await db.replacePending(
    account.account_uid,
    pendingRows.map(({ dedup_key: _d, ...r }) => r)
  );

  // Balances
  const bal = await eb.getBalances(account.account_uid);
  await db.setSessionLiveOk(account.session_pk);
  if (bal.balances?.length) {
    await db.upsertBalances(
      bal.balances.map((b) => ({
        account_uid: account.account_uid,
        balance_type: b.balance_type ?? b.name ?? "UNKNOWN",
        amount_cents: toCents(b.balance_amount.amount),
        currency: b.balance_amount.currency,
        fetched_at: new Date().toISOString(),
      }))
    );
  }

  await db.touchAccountSynced(account.account_uid);
  // Both groups share the same caps and atomic claim. Complete the normal sync
  // first so a detail rate limit prevents all subsequent bank calls.
  const budget = opts.enrichmentBudget ?? { remaining: enrichmentLimit(opts.enrichMax ?? opts.enrichMaxPerSession, ENRICH_MAX_PER_SESSION) };

  let detailAttempts = 0;
  let details_fetched = 0;
  let details_failed = 0;
  let metadataError: string | undefined;
  for (const row of candidates) {
    if (budget.stopped || budget.remaining <= 0 || detailAttempts >= accountLimit) break;
    let claim: { id: number; at: string } | undefined;
    try {
      const current = await db.persistedTransaction(row);
      if (!current || !enrichmentCandidate(current, account.name)) continue;
      const now = Date.now();
      const claimedAt = new Date(now).toISOString();
      if (!await db.claimTransactionDetail(current.id, claimedAt, new Date(now - 120_000).toISOString())) continue;
      claim = { id: current.id, at: claimedAt };
      detailAttempts++;
      budget.remaining--;
      const detail = await eb.getTransactionDetail(account.account_uid, JSON.parse(current.raw!).transaction_id);
      await db.storeTransactionDetail(current, detail);
      details_fetched++;
    } catch (error) {
      details_failed++;
      if (error instanceof RateLimitError) {
        budget.stopped = "rate_limited";
        try {
          await db.setSessionBackoff(account.session_pk, new Date(Date.now() + BACKOFF_HOURS * 3600_000).toISOString());
        } catch { metadataError = `${account.account_uid}: enrichment metadata write failed`; }
      } else if (error instanceof ExpiredSessionError) {
        budget.stopped = "expired";
        try {
          await db.setSessionExpired(account.session_pk);
        } catch { metadataError = `${account.account_uid}: enrichment metadata write failed`; }
      }
    } finally {
      if (claim) {
        try { await db.releaseTransactionDetailClaim(claim.id, claim.at); }
        catch { metadataError = `${account.account_uid}: enrichment metadata write failed`; }
      }
    }
  }
  return { account_uid: account.account_uid, new_transactions: inserted, pending: pending.length,
    details_fetched, details_failed, ...(metadataError ? { error: metadataError } : {}) };
}

export interface SyncSummary {
  sessions: number;
  accounts_synced: number;
  details_fetched: number;
  details_failed: number;
  new_transactions: number;
  errors: string[];
}

/**
 * Sync all active sessions and their accounts. Used by cron and refresh_now.
 * enrichMax overrides both caps with the same limit; 0 disables detail calls.
 * enrichBackfillDays overrides the cache lookback; 0 disables backfill only.
 */
export async function syncAll(
  env: Env,
  trigger: string,
  filter: {
    sessionPk?: string;
    accountUids?: string[];
    strategy?: "default" | "longest";
    enrichMax?: number;
    enrichMaxPerAccount?: number;
    enrichMaxPerSession?: number;
    enrichBackfillDays?: number;
  } = {}
): Promise<SyncSummary> {
  const db = new Db(env);
  const eb = new EbClient(env);
  const startedAt = new Date().toISOString();
  const summary: SyncSummary = { sessions: 0, accounts_synced: 0, new_transactions: 0, details_fetched: 0, details_failed: 0, errors: [] };

  let sessions = await db.activeSessions();
  if (filter.sessionPk) sessions = sessions.filter((s) => s.id === filter.sessionPk);

  for (const session of sessions) {
    if (session.backoff_until && new Date(session.backoff_until).getTime() > Date.now()) {
      summary.errors.push(`session ${session.psu_type}: in rate-limit backoff until ${session.backoff_until}`);
      continue;
    }
    summary.sessions++;

    const accounts = await db.accountsBySession(session.id, filter.accountUids);
    const enrichmentBudget: EnrichmentBudget = {
      remaining: enrichmentLimit(filter.enrichMax ?? filter.enrichMaxPerSession, ENRICH_MAX_PER_SESSION),
    };

    for (const account of accounts) {
      try {
        const r = await syncAccount(db, eb, account, { strategy: filter.strategy, enrichMax: filter.enrichMax,
          enrichMaxPerAccount: filter.enrichMaxPerAccount, enrichBackfillDays: filter.enrichBackfillDays, enrichmentBudget });
        summary.accounts_synced++;
        summary.new_transactions += r.new_transactions;
        summary.details_fetched += r.details_fetched;
        summary.details_failed += r.details_failed;
        if (r.error) summary.errors.push(r.error);
        if (enrichmentBudget.stopped) {
          summary.errors.push(enrichmentBudget.stopped === "rate_limited"
            ? `account sync rate-limited; backing off ${BACKOFF_HOURS}h`
            : `session ${session.psu_type}: expired; reauthorization required`);
          break;
        }
      } catch (e) {
        if (e instanceof RateLimitError) {
          await db.setSessionBackoff(session.id, new Date(Date.now() + BACKOFF_HOURS * 3600_000).toISOString());
          summary.errors.push(`account sync rate-limited; backing off ${BACKOFF_HOURS}h`);
          break; // stop hitting this session's ASPSP today
        }
        if (e instanceof ExpiredSessionError) {
          await db.setSessionExpired(session.id);
          summary.errors.push(`session ${session.psu_type}: expired; reauthorization required`);
          break;
        }
        summary.errors.push(`account sync failed (${(e as Error).name || "Error"})`);
      }
    }

    // Renewal early-warning
    if (session.valid_until) {
      const daysLeft = (new Date(session.valid_until).getTime() - Date.now()) / 86400_000;
      if (daysLeft < 14 && !session.renewal_due) {
        await db.setRenewalDue(session.id);
      }
    }
  }

  await db.insertSyncLog({
    started_at: startedAt,
    trigger_source: trigger,
    accounts_synced: summary.accounts_synced,
    new_transactions: summary.new_transactions,
    status: summary.errors.length ? "partial" : "ok",
    detail: summary.errors.join("; ") || null,
  });

  return summary;
}

export interface EnrichmentPreview {
  accounts: Array<{ account: string; candidates: number }>;
  total_candidates: number;
}

/**
 * Cache-only preview of what a refresh_now enrichment pass would fetch: no bank call, no budget spend,
 * no write. Mirrors the same account/session caps and backfill window used by a real sync so the count is
 * a faithful estimate, but only ever counts rows already in the cache.
 */
export async function previewEnrichmentCandidates(
  db: Db,
  accounts: AccountRow[],
  opts: { enrichMax?: number; enrichBackfillDays?: number } = {}
): Promise<EnrichmentPreview> {
  const backfillDays = enrichmentLimit(opts.enrichBackfillDays, ENRICH_BACKFILL_DAYS);
  const accountLimit = enrichmentLimit(opts.enrichMax, ENRICH_MAX_PER_ACCOUNT);
  const sessionBudget = enrichmentLimit(opts.enrichMax, ENRICH_MAX_PER_SESSION);
  const remainingBySession = new Map<string, number>();
  const results: Array<{ account: string; candidates: number }> = [];
  let total = 0;

  for (const account of accounts) {
    const remaining = remainingBySession.get(account.session_pk) ?? sessionBudget;
    let count = 0;
    if (backfillDays > 0 && accountLimit > 0 && remaining > 0) {
      const rows = await db.enrichmentBackfillCandidates(account.account_uid, daysAgo(backfillDays));
      const eligible = rows.filter((row) => enrichmentCandidate(row, account.name));
      count = Math.min(eligible.length, accountLimit, remaining);
    }
    remainingBySession.set(account.session_pk, remaining - count);
    results.push({ account: account.name ?? account.account_uid, candidates: count });
    total += count;
  }

  return { accounts: results, total_candidates: total };
}

/**
 * Full-history backfill, run synchronously right after authorization while the
 * ~1 hour full-history window is open. Tries progressively narrower windows.
 */
export async function backfillAccounts(env: Env, accounts: AccountRow[]): Promise<AccountSyncResult[]> {
  const db = new Db(env);
  const eb = new EbClient(env);
  const ladders = [365 * 5, 365 * 2, 365, 92];
  const results: AccountSyncResult[] = [];
  const budgets = new Map<string, EnrichmentBudget>();
  for (const account of accounts) {
    const enrichmentBudget = budgets.get(account.session_pk) ?? { remaining: ENRICH_MAX_PER_SESSION };
    budgets.set(account.session_pk, enrichmentBudget);
    if (enrichmentBudget.stopped) {
      results.push({ account_uid: account.account_uid, new_transactions: 0, pending: 0,
        details_fetched: 0, details_failed: 0, error: enrichmentBudget.stopped });
      continue;
    }
    let done = false;
    for (const days of ladders) {
      try {
        const r = await syncAccount(db, eb, account, { dateFrom: daysAgo(days), enrichmentBudget });
        results.push(r);
        done = true;
        break;
      } catch (e) {
        if (e instanceof RateLimitError || e instanceof ExpiredSessionError) {
          if (e instanceof ExpiredSessionError) await db.setSessionExpired(account.session_pk);
          results.push({ account_uid: account.account_uid, new_transactions: 0, pending: 0, details_fetched: 0, details_failed: 0, error: (e as Error).message });
          done = true;
          break;
        }
        // narrower window and retry
      }
    }
    if (!done) {
      results.push({ account_uid: account.account_uid, new_transactions: 0, pending: 0, details_fetched: 0, details_failed: 0, error: "backfill failed for all windows" });
    }
  }
  return results;
}
