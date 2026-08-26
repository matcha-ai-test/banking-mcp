import { Db } from "./db";
import { EbClient, ExpiredSessionError, RateLimitError } from "./eb";
import type { AccountRow, EbTransaction, Env, TxRow } from "./types";
import { daysAgo, isoDate, sha256Hex } from "./util";

const MAX_PAGES_PER_ACCOUNT = 80;
const OVERLAP_DAYS = 10;
const BACKOFF_HOURS = 6;

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
    // Keep only the normalized fields above. The full upstream payload can
    // contain additional personal data that banking-mcp does not use.
    raw: null,
  };
}

/** Fetch all transaction pages for an account within a window. */
async function fetchWindow(
  db: Db,
  eb: EbClient,
  account: AccountRow,
  dateFrom: string
): Promise<{ booked: EbTransaction[]; pending: EbTransaction[] }> {
  const booked: EbTransaction[] = [];
  const pending: EbTransaction[] = [];
  let continuationKey: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    const res = await eb.getTransactions(account.account_uid, { dateFrom, continuationKey });
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
  error?: string;
}

/** Reconciliation sync for one account: overlapping window, idempotent upsert. */
export async function syncAccount(
  db: Db,
  eb: EbClient,
  account: AccountRow,
  opts: { dateFrom?: string } = {}
): Promise<AccountSyncResult> {
  const dateFrom =
    opts.dateFrom ??
    (account.last_synced_at ? daysAgo(OVERLAP_DAYS, new Date(account.last_synced_at + "Z")) : daysAgo(90));

  const { booked, pending } = await fetchWindow(db, eb, account, dateFrom);

  let inserted = 0;
  if (booked.length > 0) {
    const rows = await Promise.all(booked.map((t) => toRow(account.account_uid, t)));
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.dedup_key) ? false : (seen.add(r.dedup_key), true)));
    inserted = await db.insertTransactionsIgnore(unique);
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
  return { account_uid: account.account_uid, new_transactions: inserted, pending: pending.length };
}

export interface SyncSummary {
  sessions: number;
  accounts_synced: number;
  new_transactions: number;
  errors: string[];
}

/** Sync all active sessions and their accounts. Used by cron and refresh_now. */
export async function syncAll(
  env: Env,
  trigger: string,
  filter: { sessionPk?: string; accountUid?: string } = {}
): Promise<SyncSummary> {
  const db = new Db(env);
  const eb = new EbClient(env);
  const startedAt = new Date().toISOString();
  const summary: SyncSummary = { sessions: 0, accounts_synced: 0, new_transactions: 0, errors: [] };

  let sessions = await db.activeSessions();
  if (filter.sessionPk) sessions = sessions.filter((s) => s.id === filter.sessionPk);

  for (const session of sessions) {
    if (session.backoff_until && new Date(session.backoff_until).getTime() > Date.now()) {
      summary.errors.push(`session ${session.psu_type}: in rate-limit backoff until ${session.backoff_until}`);
      continue;
    }
    summary.sessions++;

    const accounts = await db.accountsBySession(session.id, filter.accountUid);

    for (const account of accounts) {
      try {
        const r = await syncAccount(db, eb, account);
        summary.accounts_synced++;
        summary.new_transactions += r.new_transactions;
      } catch (e) {
        if (e instanceof RateLimitError) {
          await db.setSessionBackoff(session.id, new Date(Date.now() + BACKOFF_HOURS * 3600_000).toISOString());
          summary.errors.push(`account sync rate-limited; backing off ${BACKOFF_HOURS}h`);
          break; // stop hitting this session's ASPSP today
        }
        if (e instanceof ExpiredSessionError) {
          await db.setSessionExpired(session.id);
          summary.errors.push(`session ${session.psu_type}: expired — reauthorization required`);
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

/**
 * Full-history backfill, run synchronously right after authorization while the
 * ~1 hour full-history window is open. Tries progressively narrower windows.
 */
export async function backfillAccounts(env: Env, accounts: AccountRow[]): Promise<AccountSyncResult[]> {
  const db = new Db(env);
  const eb = new EbClient(env);
  const ladders = [365 * 5, 365 * 2, 365, 92];
  const results: AccountSyncResult[] = [];
  for (const account of accounts) {
    let done = false;
    for (const days of ladders) {
      try {
        const r = await syncAccount(db, eb, account, { dateFrom: daysAgo(days) });
        results.push(r);
        done = true;
        break;
      } catch (e) {
        if (e instanceof RateLimitError || e instanceof ExpiredSessionError) {
          if (e instanceof ExpiredSessionError) await db.setSessionExpired(account.session_pk);
          results.push({ account_uid: account.account_uid, new_transactions: 0, pending: 0, error: (e as Error).message });
          done = true;
          break;
        }
        // narrower window and retry
      }
    }
    if (!done) {
      results.push({ account_uid: account.account_uid, new_transactions: 0, pending: 0, error: "backfill failed for all windows" });
    }
  }
  return results;
}
