import type { AccountIdentityRow, AccountRow, AspspRow, AuthStatusSessionRow, BalanceRow, EbTransaction, EbSessionRow, Env, PsuType, TxRow } from "./types";
import { normalizeText } from "./util";
import { canonicalIban } from "./identity";

/**
 * A LIKE pattern matching `text` literally anywhere: `%` and `_` in user input
 * are wildcards otherwise ("100%" would match every row containing "100").
 * Pair with a backslash ESCAPE clause in the SQL.
 */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * D1 repository. The database is bound directly to the Worker — it has no
 * public endpoint and no credentials that can leak.
 */
export class Db {
  private d1: D1Database;

  constructor(env: Env) {
    this.d1 = env.DB;
  }

  /** Raw D1 handle for the categorization repository in src/categories.ts (bound SQL only). */
  get database(): D1Database {
    return this.d1;
  }

  // ---- sessions ----

  async activeSessions(): Promise<EbSessionRow[]> {
    const r = await this.d1
      .prepare("SELECT * FROM eb_sessions WHERE status = 'active' ORDER BY updated_at DESC")
      .all<EbSessionRow>();
    return r.results;
  }

  /**
   * Feeds the MCP auth-status payload. Deliberately never selects id or
   * session_id, so upstream session identifiers cannot reach the output layer
   * even if buildAuthStatus regresses to copying whole rows.
   */
  async allSessions(limit = 10): Promise<AuthStatusSessionRow[]> {
    const r = await this.d1
      .prepare(
        "SELECT psu_type, aspsp_name, aspsp_country, valid_until, status, refresh_count_today, refresh_count_date, renewal_due, backoff_until, last_live_verified_at, last_live_result, updated_at FROM eb_sessions ORDER BY updated_at DESC LIMIT ?"
      )
      .bind(limit)
      .all<AuthStatusSessionRow>();
    return r.results;
  }

  async sessionsNeedingWarning(): Promise<EbSessionRow[]> {
    const r = await this.d1
      .prepare("SELECT * FROM eb_sessions WHERE status IN ('active','expired')")
      .all<EbSessionRow>();
    return r.results;
  }

  /** Internal verification only: strip identifiers before passing rows to the output builder. */
  async sessionsForVerification(id?: string): Promise<EbSessionRow[]> {
    const query = id === undefined
      ? this.d1.prepare("SELECT * FROM eb_sessions ORDER BY updated_at DESC")
      : this.d1.prepare("SELECT * FROM eb_sessions WHERE id = ?").bind(id);
    return (await query.all<EbSessionRow>()).results;
  }

  /** Reserve the cooldown atomically so overlapping callers cannot both hit the bank. */
  async claimSessionVerification(id: string, verifiedAt: string, cutoff: string, pendingResult: string): Promise<boolean> {
    const result = await this.d1.prepare(
      `UPDATE eb_sessions SET live_verify_claimed_at = ?, live_verify_result = ?
       WHERE id = ? AND (live_verify_claimed_at IS NULL
         OR julianday(live_verify_claimed_at) <= julianday(?))`
    ).bind(verifiedAt, pendingResult, id, cutoff).run();
    return result.meta.changes > 0;
  }

  async setSessionVerificationResult(id: string, verifiedAt: string, result: string): Promise<void> {
    // Only the current claim may complete; an older request cannot overwrite a newer claim.
    await this.d1.prepare(
      "UPDATE eb_sessions SET live_verify_result = ? WHERE id = ? AND live_verify_claimed_at = ?"
    ).bind(result, id, verifiedAt).run();
  }

  async insertSession(row: {
    id: string;
    session_id: string;
    psu_type: PsuType;
    valid_until: string | null;
    aspsp_name: string;
    aspsp_country: string;
  }): Promise<void> {
    await this.d1
      .prepare(
        "INSERT INTO eb_sessions (id, session_id, psu_type, valid_until, aspsp_name, aspsp_country, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"
      )
      .bind(row.id, row.session_id, row.psu_type, row.valid_until, row.aspsp_name, row.aspsp_country)
      .run();
  }

  async replaceActiveSessions(psuType: PsuType, aspspName: string): Promise<void> {
    await this.d1
      .prepare(
        "UPDATE eb_sessions SET status = 'replaced', updated_at = datetime('now') WHERE psu_type = ? AND aspsp_name = ? AND status = 'active'"
      )
      .bind(psuType, aspspName)
      .run();
  }

  async setSessionBackoff(id: string, untilIso: string): Promise<void> {
    await this.d1
      .prepare("UPDATE eb_sessions SET backoff_until = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(untilIso, id)
      .run();
  }

  async setSessionExpired(id: string): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE eb_sessions
         SET status = 'expired', renewal_due = 1,
             last_live_verified_at = datetime('now'), last_live_result = 'expired_session',
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(id)
      .run();
  }

  async setSessionLiveOk(id: string): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE eb_sessions
         SET last_live_verified_at = datetime('now'), last_live_result = 'ok', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(id)
      .run();
  }

  async setRenewalDue(id: string): Promise<void> {
    await this.d1
      .prepare("UPDATE eb_sessions SET renewal_due = 1, updated_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  async bumpRefreshCount(id: string, newCount: number, date: string): Promise<void> {
    await this.d1
      .prepare(
        "UPDATE eb_sessions SET refresh_count_today = ?, refresh_count_date = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(newCount, date, id)
      .run();
  }

  /**
   * Atomically charge an attempt before dispatch; failed requests keep their charge.
   * RETURNING captures this caller's count: budget_left_today = limit - (count after this charge).
   * An uncharged attempt has no returned row; its count is unused.
   */
  async tryChargeRefreshBudget(sessionId: string, today: string, limit: number): Promise<{ charged: boolean; count: number }> {
    const row = await this.d1.prepare(
      "UPDATE eb_sessions SET refresh_count_today = CASE WHEN refresh_count_date = ? THEN refresh_count_today + 1 ELSE 1 END, refresh_count_date = ? WHERE id = ? AND (refresh_count_date IS NULL OR refresh_count_date != ? OR refresh_count_today < ?) RETURNING refresh_count_today"
    ).bind(today, today, sessionId, today, limit).first<{ refresh_count_today: number }>();
    return { charged: row !== null, count: row?.refresh_count_today ?? 0 };
  }

  // ---- accounts ----

  async allAccounts(): Promise<AccountRow[]> {
    const r = await this.d1.prepare("SELECT * FROM accounts ORDER BY name").all<AccountRow>();
    return r.results;
  }

  async allAccountsWithBank(): Promise<Array<AccountRow & { aspsp_name: string | null; label: string | null; label_revision: number | null }>> {
    const r = await this.d1
      .prepare(
        `SELECT a.*, s.aspsp_name, l.label, l.revision AS label_revision
           FROM accounts a
           LEFT JOIN eb_sessions s ON s.id = a.session_pk
           LEFT JOIN account_labels l ON l.account_identity_id = a.account_identity_id
          ORDER BY s.aspsp_name, a.name`
      )
      .all<AccountRow & { aspsp_name: string | null; label: string | null; label_revision: number | null }>();
    return r.results;
  }

  async accountsBySession(sessionPk: string, accountUids?: string[]): Promise<AccountRow[]> {
    const r = await this.d1.prepare("SELECT * FROM accounts WHERE session_pk = ?").bind(sessionPk).all<AccountRow>();
    if (!accountUids) return r.results;
    const wanted = new Set(accountUids);
    return r.results.filter((a) => wanted.has(a.account_uid));
  }

  async upsertAccounts(rows: AccountRow[]): Promise<void> {
    if (rows.length === 0) return;
    // account_identity_id is deliberately excluded from DO UPDATE SET: the
    // registry pointer, once assigned, must survive a re-auth of the same uid.
    const stmt = this.d1.prepare(
      `INSERT INTO accounts (account_uid, session_pk, name, iban, currency, psu_type, product,
         cash_account_type, credit_limit_cents, usage, bic, card_last4, identification_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_uid) DO UPDATE SET
         session_pk = excluded.session_pk, name = excluded.name, iban = excluded.iban,
         currency = excluded.currency, psu_type = excluded.psu_type, product = excluded.product,
         cash_account_type = excluded.cash_account_type, credit_limit_cents = excluded.credit_limit_cents,
         usage = excluded.usage, bic = excluded.bic, card_last4 = excluded.card_last4,
         identification_hash = COALESCE(excluded.identification_hash, accounts.identification_hash)`
    );
    await this.d1.batch(rows.map((a) => stmt.bind(a.account_uid, a.session_pk, a.name, a.iban, a.currency, a.psu_type, a.product,
      a.cash_account_type ?? null, a.credit_limit_cents ?? null, a.usage ?? null, a.bic ?? null, a.card_last4 ?? null,
      a.identification_hash ?? null)));
  }

  /**
   * Prior-generation account rows that are safe to fold into keepUid — the residue of earlier
   * re-authorizations, since Enable Banking mints a fresh uid on each auth. The candidate set is
   * the union of (a) rows sharing keepUid's registry identity and (b) legacy rows with no
   * identity pointer that match the new row's IBAN/currency/psu_type exactly (only considered
   * when the new row has an IBAN). A candidate is dropped, even from (a), when its own IBAN is
   * non-null and canonically differs from the new row's IBAN, when its psu_type differs, or when
   * it is itself part of the current auth batch (batchUids) — folding two fresh rows from the
   * same session into each other would be wrong even if they briefly shared an identity. Oldest
   * first, so the earliest-created row survives on collapse.
   *
   * IBAN is authoritative for folding: two rows sharing the same canonical IBAN (+ psu_type,
   * currency IS) are the same account regardless of identification_hash, so the legacy arm never
   * compares hashes — a differing hash on an IBAN match just means the bank sent a different hash
   * for the same account across generations, not a different account.
   */
  async staleAccountGenerations(
    iban: string | null,
    currency: string | null,
    psuType: PsuType,
    keepUid: string,
    identityId?: string | null,
    batchUids?: Iterable<string>
  ): Promise<string[]> {
    type Candidate = {
      account_uid: string;
      iban: string | null;
      psu_type: PsuType;
      created_at: string;
    };
    const candidates = new Map<string, Candidate>();

    if (identityId) {
      const r = await this.d1
        .prepare(
          `SELECT account_uid, iban, psu_type, created_at FROM accounts
           WHERE account_identity_id = ? AND account_uid != ? ORDER BY created_at ASC`
        )
        .bind(identityId, keepUid)
        .all<Candidate>();
      for (const row of r.results) candidates.set(row.account_uid, row);
    }
    if (iban) {
      const r = await this.d1
        .prepare(
          `SELECT account_uid, iban, psu_type, created_at FROM accounts
           WHERE account_identity_id IS NULL AND iban = ? AND currency IS ? AND psu_type = ? AND account_uid != ?
           ORDER BY created_at ASC`
        )
        .bind(iban, currency, psuType, keepUid)
        .all<Candidate>();
      for (const row of r.results) candidates.set(row.account_uid, row);
    }

    const newIban = canonicalIban(iban);
    const exclude = new Set(batchUids ?? []);
    exclude.add(keepUid);

    return [...candidates.values()]
      .filter((c) => {
        if (exclude.has(c.account_uid)) return false;
        if (c.psu_type !== psuType) return false;
        // Only rows that both carry the same canonical IBAN, or both carry
        // none, may be folded — symmetric fail-closed. A candidate with a
        // real IBAN must never be silently merged into an IBAN-less row, and
        // an IBAN-less candidate must never be merged into an IBAN-bearing
        // row either.
        // Gate on the raw column first so an uncanonicalizable IBAN still counts as "has IBAN".
        if ((iban == null) !== (c.iban == null)) return false;
        if (iban == null) return true;
        const candIban = canonicalIban(c.iban);
        return newIban !== null && candIban !== null ? candIban === newIban : c.iban === iban;
      })
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .map((c) => c.account_uid);
  }

  /**
   * Fold a stale generation's rows onto the surviving uid, then drop the stale account.
   * UPDATE OR IGNORE re-points transactions but skips any that would collide on
   * UNIQUE(account_uid, dedup_key) — the same booked transaction already present under
   * keepUid — so the earlier copy is kept and the duplicate removed. Balances/pending carry
   * no history worth keeping and are dropped; the next sync repopulates them under keepUid.
   */
  async foldAccountGeneration(staleUid: string, keepUid: string): Promise<{ moved: number; collapsed: number }> {
    const upd = await this.d1
      .prepare("UPDATE OR IGNORE transactions SET account_uid = ? WHERE account_uid = ?")
      .bind(keepUid, staleUid)
      .run();
    const moved = upd.meta.changes ?? 0;
    const del = await this.d1
      .prepare("DELETE FROM transactions WHERE account_uid = ?")
      .bind(staleUid)
      .run();
    const collapsed = del.meta.changes ?? 0;
    await this.d1.prepare("DELETE FROM pending_transactions WHERE account_uid = ?").bind(staleUid).run();
    await this.d1.prepare("DELETE FROM balances WHERE account_uid = ?").bind(staleUid).run();
    await this.d1.prepare("DELETE FROM accounts WHERE account_uid = ?").bind(staleUid).run();
    return { moved, collapsed };
  }

  async touchAccountSynced(accountUid: string): Promise<void> {
    await this.d1
      .prepare("UPDATE accounts SET last_synced_at = datetime('now') WHERE account_uid = ?")
      .bind(accountUid)
      .run();
  }

  // ---- transactions ----

  /** Resolve a booked cache row without fetching or modifying bank data. */
  async findTransactionDetails(opts: {
    transactionId?: string;
    bookingDate: string;
    amountCents: number;
    accountUids?: string[] | null;
  }): Promise<TxRow[]> {
    if (opts.accountUids?.length === 0) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.transactionId !== undefined) {
      where.push("CASE WHEN json_valid(raw) THEN json_extract(raw, '$.transaction_id') END = ?");
      params.push(opts.transactionId);
    } else {
      where.push("booking_date = ?", "(CASE WHEN credit_debit = 'DBIT' THEN -ABS(amount_cents) ELSE ABS(amount_cents) END) = ?");
      params.push(opts.bookingDate, opts.amountCents);
    }
    if (opts.accountUids) {
      where.push(`account_uid IN (${opts.accountUids.map(() => "?").join(",")})`);
      params.push(...opts.accountUids);
    }
    return (await this.d1.prepare(
      `SELECT * FROM transactions WHERE ${where.join(" AND ")} ORDER BY booking_date DESC, id DESC`
    ).bind(...params).all<TxRow>()).results;
  }

  /** Idempotent insert; returns number of newly inserted rows. */
  async insertTransactionsIgnore(rows: TxRow[], insertedRows?: Array<TxRow & { id: number }>): Promise<number> {
    if (rows.length === 0) return 0;
    const stmt = this.d1.prepare(
      `INSERT OR IGNORE INTO transactions
       (account_uid, booking_date, value_date, amount_cents, currency, credit_debit, counterparty, remittance_info, entry_reference, dedup_key, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    // batch in chunks to stay well under D1 statement limits
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const results = await this.d1.batch(
        chunk.map((t) =>
          stmt.bind(
            t.account_uid, t.booking_date, t.value_date, t.amount_cents, t.currency, t.credit_debit,
            t.counterparty, t.remittance_info, t.entry_reference, t.dedup_key, t.raw
          )
        )
      );
      for (const [index, r] of results.entries()) {
        inserted += r.meta.changes ?? 0;
        if (r.meta.changes > 0) insertedRows?.push({ ...chunk[index], id: r.meta.last_row_id });
      }
    }
    return inserted;
  }

  /** Load recent cache rows; guarded JSON/text eligibility is checked by the caller. */
  async enrichmentBackfillCandidates(accountUid: string, dateFrom: string): Promise<Array<TxRow & { id: number }>> {
    return (await this.d1.prepare(
      `SELECT * FROM transactions WHERE account_uid = ? AND booking_date >= ?
       AND detail_fetched_at IS NULL ORDER BY booking_date DESC, id DESC`
    ).bind(accountUid, dateFrom).all<TxRow & { id: number }>()).results;
  }

  /** Re-read the persisted row before detail dispatch or storage. */
  async persistedTransaction(row: TxRow): Promise<(TxRow & { id: number }) | null> {
    return this.d1.prepare("SELECT * FROM transactions WHERE account_uid = ? AND dedup_key = ?")
      .bind(row.account_uid, row.dedup_key).first<TxRow & { id: number }>();
  }

  /** Atomically coordinate detail dispatch across sync and on-demand callers. */
  async claimTransactionDetail(rowId: number, nowIso: string, staleCutoffIso: string): Promise<boolean> {
    const claimed = await this.d1.prepare(
      `UPDATE transactions SET detail_claimed_at = ? WHERE id = ? AND detail_fetched_at IS NULL
       AND (detail_claimed_at IS NULL OR detail_claimed_at < ?) RETURNING id`
    ).bind(nowIso, rowId, staleCutoffIso).first<{ id: number }>();
    return claimed !== null;
  }

  /** Only release our lease, never a newer caller's stale-claim takeover. */
  async releaseTransactionDetailClaim(rowId: number, claimedAt: string): Promise<void> {
    await this.d1.prepare("UPDATE transactions SET detail_claimed_at = NULL WHERE id = ? AND detail_claimed_at = ?")
      .bind(rowId, claimedAt).run();
  }

  /** Cache detail once without modifying transaction identity, amounts or dates. */
  async storeTransactionDetail(row: TxRow, detail: EbTransaction): Promise<EbTransaction> {
    const current = await this.persistedTransaction(row);
    if (!current) throw new Error("Transaction no longer cached");
    const cachedDetail = (stored: TxRow): EbTransaction | null => {
      let raw;
      try { raw = JSON.parse(stored.raw ?? "null"); } catch { raw = null; }
      return raw?.detail ?? (stored.detail_fetched_at != null ? raw ?? {} : null);
    };
    const cached = cachedDetail(current);
    if (cached !== null) return cached;
    const remittance = (detail.remittance_information ?? []).join(" ").trim();
    const counterparty = (row.credit_debit === "DBIT" ? detail.creditor?.name : detail.debtor?.name) ?? null;
    const result = await this.d1.prepare(
      `UPDATE transactions SET
         raw = json_set(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END, '$.detail', json(?)),
         detail_fetched_at = ?,
         counterparty = CASE WHEN ? <> '' AND ? IS NOT remittance_info
           THEN COALESCE(counterparty, ?) ELSE counterparty END,
         remittance_info = CASE WHEN ? <> '' AND ? IS NOT remittance_info
           THEN ? ELSE remittance_info END
       WHERE id = ? AND detail_fetched_at IS NULL`
    ).bind(JSON.stringify(detail), new Date().toISOString(), remittance, remittance, counterparty,
      remittance, remittance, remittance, current.id).run();
    if (result.meta.changes > 0) return detail;
    const winner = await this.persistedTransaction(current);
    const winnerDetail = winner && cachedDetail(winner);
    if (winnerDetail === null) throw new Error("Transaction detail was not persisted");
    return winnerDetail;
  }

  async queryTransactions(opts: {
    table?: "transactions" | "pending_transactions";
    accountUids?: string[] | null;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    limit: number;
  }): Promise<Array<TxRow & { id: number }>> {
    const table = opts.table ?? "transactions";
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.accountUids && opts.accountUids.length > 0) {
      where.push(`account_uid IN (${opts.accountUids.map(() => "?").join(",")})`);
      params.push(...opts.accountUids);
    }
    if (opts.dateFrom) {
      where.push("booking_date >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      where.push("booking_date <= ?");
      params.push(opts.dateTo);
    }
    if (opts.search) {
      where.push("(counterparty LIKE ? ESCAPE '\\' OR remittance_info LIKE ? ESCAPE '\\')");
      const like = likeContains(opts.search);
      params.push(like, like);
    }
    const sql = `SELECT * FROM ${table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY booking_date DESC, id DESC LIMIT ?`;
    params.push(opts.limit);
    const r = await this.d1.prepare(sql).bind(...params).all<TxRow & { id: number }>();
    return r.results;
  }

  /**
   * Server-side aggregation over cached booked transactions so the client model
   * never has to add up hundreds of rows itself. Grouped per currency always,
   * plus one optional dimension. Amounts stay in cents; the caller formats.
   */
  async summarizeTransactions(opts: {
    accountUids?: string[] | null;
    dateFrom?: string;
    dateTo?: string;
    groupBy: "month" | "counterparty" | "account" | "currency";
    limit: number;
  }): Promise<Array<{ key: string; currency: string; out_cents: number; in_cents: number; count: number }>> {
    if (opts.accountUids?.length === 0) return [];
    const keyExpr = {
      month: "substr(booking_date, 1, 7)",
      counterparty: "COALESCE(NULLIF(TRIM(counterparty), ''), NULLIF(TRIM(remittance_info), ''), '(unknown)')",
      account: "account_uid",
      currency: "currency",
    }[opts.groupBy];
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.accountUids) {
      where.push(`account_uid IN (${opts.accountUids.map(() => "?").join(",")})`);
      params.push(...opts.accountUids);
    }
    if (opts.dateFrom) { where.push("booking_date >= ?"); params.push(opts.dateFrom); }
    if (opts.dateTo) { where.push("booking_date <= ?"); params.push(opts.dateTo); }
    params.push(opts.limit);
    const sql = `SELECT ${keyExpr} AS key, currency,
        COALESCE(SUM(CASE WHEN credit_debit = 'DBIT' THEN ABS(amount_cents) ELSE 0 END), 0) AS out_cents,
        COALESCE(SUM(CASE WHEN credit_debit <> 'DBIT' THEN ABS(amount_cents) ELSE 0 END), 0) AS in_cents,
        COUNT(*) AS count
      FROM transactions ${where.length ? "WHERE " + where.join(" AND ") : ""}
      GROUP BY key, currency
      ORDER BY ${opts.groupBy === "month" ? "key DESC" : "out_cents DESC, in_cents DESC"}, currency
      LIMIT ?`;
    return (await this.d1.prepare(sql).bind(...params).all<{ key: string; currency: string; out_cents: number; in_cents: number; count: number }>()).results;
  }

  /** Total booked credits per currency in a window; the basis for the work-time estimate. */
  async inflowTotals(opts: { accountUids?: string[] | null; dateFrom: string; dateTo: string }):
    Promise<Array<{ currency: string; in_cents: number; count: number }>> {
    if (opts.accountUids?.length === 0) return [];
    const where = ["credit_debit <> 'DBIT'", "booking_date >= ?", "booking_date <= ?"];
    const params: unknown[] = [opts.dateFrom, opts.dateTo];
    if (opts.accountUids) {
      where.push(`account_uid IN (${opts.accountUids.map(() => "?").join(",")})`);
      params.push(...opts.accountUids);
    }
    return (await this.d1.prepare(
      `SELECT currency, COALESCE(SUM(ABS(amount_cents)), 0) AS in_cents, COUNT(*) AS count
       FROM transactions WHERE ${where.join(" AND ")} GROUP BY currency ORDER BY in_cents DESC`
    ).bind(...params).all<{ currency: string; in_cents: number; count: number }>()).results;
  }

  async replacePending(accountUid: string, rows: Omit<TxRow, "dedup_key">[]): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      this.d1.prepare("DELETE FROM pending_transactions WHERE account_uid = ?").bind(accountUid),
    ];
    const ins = this.d1.prepare(
      `INSERT INTO pending_transactions
       (account_uid, booking_date, value_date, amount_cents, currency, credit_debit, counterparty, remittance_info, entry_reference, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of rows) {
      stmts.push(
        ins.bind(
          t.account_uid, t.booking_date, t.value_date, t.amount_cents, t.currency, t.credit_debit,
          t.counterparty, t.remittance_info, t.entry_reference, t.raw
        )
      );
    }
    await this.d1.batch(stmts);
  }

  // ---- balances ----

  async upsertBalances(rows: BalanceRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.d1.prepare(
      `INSERT INTO balances (account_uid, balance_type, amount_cents, currency, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_uid, balance_type) DO UPDATE SET
         amount_cents = excluded.amount_cents, currency = excluded.currency, fetched_at = excluded.fetched_at`
    );
    await this.d1.batch(rows.map((b) => stmt.bind(b.account_uid, b.balance_type, b.amount_cents, b.currency, b.fetched_at)));
  }

  async balances(accountUids?: string[] | null): Promise<Array<BalanceRow & { name: string | null; iban: string | null }>> {
    let sql =
      "SELECT b.*, a.name, a.iban FROM balances b LEFT JOIN accounts a ON a.account_uid = b.account_uid";
    const params: unknown[] = [];
    if (accountUids && accountUids.length > 0) {
      sql += ` WHERE b.account_uid IN (${accountUids.map(() => "?").join(",")})`;
      params.push(...accountUids);
    }
    const r = await this.d1.prepare(sql).bind(...params).all<BalanceRow & { name: string | null; iban: string | null }>();
    return r.results;
  }

  // ---- ASPSP (bank list) cache ----

  /** Upsert bank rows; a partial (per-country) fetch never removes other countries. */
  async upsertAspsps(rows: AspspRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.d1.prepare(
      `INSERT INTO aspsp_cache (name, country, psu_types, maximum_consent_validity, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name, country) DO UPDATE SET
         psu_types = excluded.psu_types, maximum_consent_validity = excluded.maximum_consent_validity,
         fetched_at = excluded.fetched_at`
    );
    for (let i = 0; i < rows.length; i += 50) {
      await this.d1.batch(rows.slice(i, i + 50).map((r) =>
        stmt.bind(r.name, r.country, r.psu_types, r.maximum_consent_validity, r.fetched_at)));
    }
  }

  async aspspCacheFetchedAt(): Promise<string | null> {
    const row = await this.d1.prepare("SELECT MAX(fetched_at) AS fetched_at FROM aspsp_cache").first<{ fetched_at: string | null }>();
    return row?.fetched_at ?? null;
  }

  async queryAspsps(opts: { country?: string; search?: string; limit: number }): Promise<AspspRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.country) { where.push("country = ?"); params.push(opts.country.toUpperCase()); }
    if (opts.search) { where.push("name LIKE ? ESCAPE '\\'"); params.push(likeContains(opts.search)); }
    params.push(opts.limit);
    return (await this.d1.prepare(
      `SELECT * FROM aspsp_cache ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY country, name LIMIT ?`
    ).bind(...params).all<AspspRow>()).results;
  }

  // ---- auth state ----

  async insertAuthState(state: string, psuType: PsuType): Promise<void> {
    await this.d1.prepare("INSERT INTO auth_state (state, psu_type) VALUES (?, ?)").bind(state, psuType).run();
  }

  /** Atomic single-use consumption within TTL; returns psu_type or null. */
  async consumeAuthState(state: string, ttlMinutes: number): Promise<PsuType | null> {
    const row = await this.d1
      .prepare(
        `UPDATE auth_state SET used_at = datetime('now')
         WHERE state = ? AND used_at IS NULL AND created_at > datetime('now', ?)
         RETURNING psu_type`
      )
      .bind(state, `-${ttlMinutes} minutes`)
      .first<{ psu_type: PsuType }>();
    return row?.psu_type ?? null;
  }

  // ---- sync log ----

  async insertSyncLog(row: {
    started_at: string;
    trigger_source: string;
    accounts_synced: number;
    new_transactions: number;
    status: string;
    detail: string | null;
  }): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO sync_log (started_at, finished_at, trigger_source, accounts_synced, new_transactions, status, detail)
         VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`
      )
      .bind(row.started_at, row.trigger_source, row.accounts_synced, row.new_transactions, row.status, row.detail)
      .run();
  }

  // ---- rate limit ----

  /**
   * Fixed-window rate limiter. Returns true if the action is allowed.
   * One atomic upsert: a fresh or expired window resets to 1, an open window
   * increments only while under max, so concurrent callers cannot overshoot.
   */
  async rateLimitOk(key: string, max: number, windowMs: number): Promise<boolean> {
    const windowSeconds = Math.ceil(windowMs / 1000);
    const row = await this.d1
      .prepare(
        `INSERT INTO rate_limit (key, count, window_start) VALUES (?, 1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start <= datetime('now', ?) THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start <= datetime('now', ?) THEN datetime('now') ELSE window_start END
         WHERE window_start <= datetime('now', ?) OR count < ?
         RETURNING count`
      )
      .bind(key, `-${windowSeconds} seconds`, `-${windowSeconds} seconds`, `-${windowSeconds} seconds`, max)
      .first<{ count: number }>();
    return row !== null;
  }

  /**
   * Housekeeping for the nightly cron: rate-limit windows are at most an hour,
   * so rows older than a day are dead weight; auth_state rows are single-use
   * and expire after `authStateTtlMinutes`, so used or expired ones can go.
   */
  async pruneEphemeralRows(authStateTtlMinutes: number): Promise<{ rate_limit: number; auth_state: number }> {
    const [rateLimit, authState] = await this.d1.batch([
      this.d1.prepare("DELETE FROM rate_limit WHERE window_start < datetime('now', '-1 day')"),
      this.d1.prepare("DELETE FROM auth_state WHERE used_at IS NOT NULL OR created_at <= datetime('now', ?)")
        .bind(`-${authStateTtlMinutes} minutes`),
    ]);
    return { rate_limit: rateLimit.meta.changes ?? 0, auth_state: authState.meta.changes ?? 0 };
  }

  // ---- account identities (Step 0) ----

  async identityByIban(iban: string, currency: string, psuType: PsuType): Promise<AccountIdentityRow | null> {
    return this.d1.prepare("SELECT * FROM account_identities WHERE iban = ? AND currency = ? AND psu_type = ?")
      .bind(iban, currency, psuType).first<AccountIdentityRow>();
  }

  async identityByHash(hash: string, currency: string, psuType: PsuType): Promise<AccountIdentityRow | null> {
    return this.d1.prepare("SELECT * FROM account_identities WHERE identification_hash = ? AND currency = ? AND psu_type = ?")
      .bind(hash, currency, psuType).first<AccountIdentityRow>();
  }

  async identityById(id: string): Promise<AccountIdentityRow | null> {
    return this.d1.prepare("SELECT * FROM account_identities WHERE id = ?").bind(id).first<AccountIdentityRow>();
  }

  /**
   * A plain INSERT, not INSERT OR IGNORE: a UNIQUE collision (a concurrent
   * creator won the identity) is the only outcome that means "someone else
   * already has this row" and maps to false. Any other error (e.g. a CHECK
   * violation) is a real, unexpected failure and must propagate, so
   * assignAccountIdentities classifies it as transient_error and the backfill
   * latch stays not-done rather than silently treating it as a lost race.
   */
  async insertIdentityIgnore(row: { id: string; iban: string | null; identification_hash: string | null; currency: string; psu_type: PsuType }): Promise<boolean> {
    try {
      const result = await this.d1.prepare(
        "INSERT INTO account_identities (id, iban, identification_hash, currency, psu_type) VALUES (?, ?, ?, ?, ?)"
      ).bind(row.id, row.iban, row.identification_hash, row.currency, row.psu_type).run();
      return result.meta.changes > 0;
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  async attachIdentityIban(id: string, iban: string): Promise<boolean> {
    try {
      const result = await this.d1.prepare(
        "UPDATE account_identities SET iban = ?, updated_at = datetime('now') WHERE id = ? AND iban IS NULL"
      ).bind(iban, id).run();
      return result.meta.changes > 0;
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  async attachIdentityHash(id: string, hash: string): Promise<boolean> {
    try {
      const result = await this.d1.prepare(
        "UPDATE account_identities SET identification_hash = ?, updated_at = datetime('now') WHERE id = ? AND identification_hash IS NULL"
      ).bind(hash, id).run();
      return result.meta.changes > 0;
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  async setAccountIdentityIfNull(uid: string, identityId: string): Promise<void> {
    await this.d1.prepare("UPDATE accounts SET account_identity_id = ? WHERE account_uid = ? AND account_identity_id IS NULL")
      .bind(identityId, uid).run();
  }

  /** A pointer that already exists and disagrees with identityId is left untouched; returns false. */
  async verifyAccountIdentity(uid: string, identityId: string): Promise<boolean> {
    const current = await this.accountIdentityOf(uid);
    return current === identityId;
  }

  async accountIdentityOf(uid: string): Promise<string | null> {
    const row = await this.d1.prepare("SELECT account_identity_id FROM accounts WHERE account_uid = ?")
      .bind(uid).first<{ account_identity_id: string | null }>();
    return row?.account_identity_id ?? null;
  }

  /** Remember a fail-closed resolution so the backfill stops retrying it; only on a row still without a pointer. */
  async markIdentityConflict(uid: string, conflictKey: string): Promise<void> {
    await this.d1.prepare("UPDATE accounts SET identity_conflict_key = ? WHERE account_uid = ? AND account_identity_id IS NULL")
      .bind(conflictKey, uid).run();
  }

  async accountsWithoutIdentity(): Promise<AccountRow[]> {
    const r = await this.d1.prepare(
      "SELECT * FROM accounts WHERE account_identity_id IS NULL AND (iban IS NOT NULL OR identification_hash IS NOT NULL) ORDER BY created_at ASC"
    ).all<AccountRow>();
    return r.results;
  }

  async accountUidsForIdentity(identityId: string): Promise<string[]> {
    const r = await this.d1.prepare("SELECT account_uid FROM accounts WHERE account_identity_id = ? ORDER BY created_at ASC")
      .bind(identityId).all<{ account_uid: string }>();
    return r.results.map((x) => x.account_uid);
  }

  async accountIdentitiesForUids(uids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < uids.length; i += 90) {
      const chunk = uids.slice(i, i + 90);
      const r = await this.d1.prepare(
        `SELECT account_uid, account_identity_id FROM accounts WHERE account_uid IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk).all<{ account_uid: string; account_identity_id: string | null }>();
      for (const row of r.results) out.set(row.account_uid, row.account_identity_id);
    }
    return out;
  }

  // ---- account labels (Step 1) ----

  /** A tombstoned row (label IS NULL after a clear) is not a label: excluded here so every
   * caller of labelsByIdentity treats a cleared identity exactly like one that never had a row. */
  async labelsByIdentity(ids: string[]): Promise<Map<string, { label: string; revision: number }>> {
    const out = new Map<string, { label: string; revision: number }>();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      if (chunk.length === 0) continue;
      const r = await this.d1.prepare(
        `SELECT account_identity_id, label, revision FROM account_labels
         WHERE account_identity_id IN (${chunk.map(() => "?").join(",")}) AND label IS NOT NULL`
      ).bind(...chunk).all<{ account_identity_id: string; label: string; revision: number }>();
      for (const row of r.results) out.set(row.account_identity_id, { label: row.label, revision: row.revision });
    }
    return out;
  }

  /**
   * label_norm carries the DB-level uniqueness guarantee (idx_account_labels_norm):
   * a concurrent writer racing on the same normalized label collides here even
   * when the collision-scan read in the caller missed it. A UNIQUE failure on
   * that index maps to "label_collision"; any other error propagates.
   */
  async upsertLabel(identityId: string, label: string, expectedRevision: number | null): Promise<{ ok: true; revision: number } | { ok: false; reason: "revision_conflict" | "label_collision" }> {
    const labelNorm = normalizeText(label).toLowerCase();
    try {
      if (expectedRevision === null) {
        // Idempotent no-op: an unlocked write of the exact stored text must not
        // bump the revision. A case-only change is a real edit and is written.
        // One atomic statement: the CASE arms compare the pre-write stored
        // label (account_labels.label) against the incoming value (excluded.label)
        // with IS, so a genuine no-op never bumps revision or updated_at even
        // under concurrent writers.
        const row = await this.d1.prepare(
          `INSERT INTO account_labels (account_identity_id, label, label_norm) VALUES (?, ?, ?)
           ON CONFLICT(account_identity_id) DO UPDATE SET
             label = excluded.label, label_norm = excluded.label_norm,
             revision = account_labels.revision + CASE WHEN account_labels.label IS excluded.label THEN 0 ELSE 1 END,
             updated_at = CASE WHEN account_labels.label IS excluded.label THEN account_labels.updated_at ELSE datetime('now') END
           RETURNING revision, label`
        ).bind(identityId, label, labelNorm).first<{ revision: number; label: string }>();
        if (row === null) throw new Error("upsertLabel: RETURNING produced no row");
        return { ok: true, revision: row.revision };
      }
      const row = await this.d1.prepare(
        `UPDATE account_labels SET label = ?, label_norm = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE account_identity_id = ? AND revision = ? RETURNING revision`
      ).bind(label, labelNorm, identityId, expectedRevision).first<{ revision: number }>();
      if (row) return { ok: true, revision: row.revision };
      return { ok: false, reason: "revision_conflict" };
    } catch (error) {
      if (/UNIQUE constraint failed.*label_norm/i.test(error instanceof Error ? error.message : String(error))) {
        return { ok: false, reason: "label_collision" };
      }
      throw error;
    }
  }

  /** Direct scan of account_labels itself, so a label left on an identity with
   * no current accounts row (missed by the accounts join) still blocks reuse. */
  async labelNormCollision(labelNorm: string, excludeIdentityId: string): Promise<boolean> {
    const row = await this.d1.prepare(
      "SELECT 1 FROM account_labels WHERE label_norm = ? AND account_identity_id != ? LIMIT 1"
    ).bind(labelNorm, excludeIdentityId).first();
    return row !== null;
  }

  /**
   * Clearing tombstones the row (label and label_norm set to NULL, revision
   * bumped) rather than deleting it, so a revision never rewinds: a later
   * set() continues from the revision the clear left behind instead of
   * restarting at 1. Freeing label_norm also releases the normalized text for
   * reuse by another identity (the UNIQUE index allows multiple NULLs).
   *
   * Unlocked clear is always success (no label left is the goal either way)
   * and is a true no-op — no revision bump — when there is no row yet or the
   * row is already tombstoned. Locked clear is success also when no row
   * exists at all (goal already achieved); revision_conflict only when a row
   * exists with a different revision than expected.
   */
  async deleteLabel(
    identityId: string,
    expectedRevision: number | null
  ): Promise<{ ok: true; revision: number | null } | { ok: false; reason: "revision_conflict" }> {
    if (expectedRevision === null) {
      // Single atomic statement: only a live label (label IS NOT NULL) matches,
      // so a genuine no-op (no row, or already tombstoned) never bumps revision.
      const clearStmt = `UPDATE account_labels SET label = NULL, label_norm = NULL, revision = revision + 1, updated_at = datetime('now')
         WHERE account_identity_id = ? AND label IS NOT NULL RETURNING revision`;
      const row = await this.d1.prepare(clearStmt).bind(identityId).first<{ revision: number }>();
      if (row) return { ok: true, revision: row.revision };
      // Zero rows updated: either there is no row, it is already tombstoned
      // (both are the goal already achieved), or a concurrent set() landed a
      // live label between our UPDATE's WHERE evaluation and this read. Only
      // the last case still needs clearing, so re-read and, if a live label
      // is now present, run the same UPDATE once more.
      const current = await this.d1.prepare(
        "SELECT revision, label FROM account_labels WHERE account_identity_id = ?"
      ).bind(identityId).first<{ revision: number; label: string | null }>();
      if (!current || current.label === null) return { ok: true, revision: current?.revision ?? null };
      const retried = await this.d1.prepare(clearStmt).bind(identityId).first<{ revision: number }>();
      if (retried) return { ok: true, revision: retried.revision };
      // The concurrent writer's label was itself cleared or replaced again in
      // between; re-read once more rather than assuming success.
      const after = await this.d1.prepare(
        "SELECT revision, label FROM account_labels WHERE account_identity_id = ?"
      ).bind(identityId).first<{ revision: number; label: string | null }>();
      // Still live after two attempts: report a retryable conflict, never a false success.
      if (after && after.label !== null) return { ok: false, reason: "revision_conflict" };
      return { ok: true, revision: after?.revision ?? null };
    }
    const row = await this.d1.prepare(
      `UPDATE account_labels SET label = NULL, label_norm = NULL, revision = revision + 1, updated_at = datetime('now')
       WHERE account_identity_id = ? AND revision = ? AND label IS NOT NULL RETURNING revision`
    ).bind(identityId, expectedRevision).first<{ revision: number }>();
    if (row) return { ok: true, revision: row.revision };
    const current = await this.d1.prepare(
      "SELECT revision, label FROM account_labels WHERE account_identity_id = ?"
    ).bind(identityId).first<{ revision: number; label: string | null }>();
    if (!current || current.label === null) return { ok: true, revision: current?.revision ?? null };
    return { ok: false, reason: "revision_conflict" };
  }
}
