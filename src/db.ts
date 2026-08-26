import type { AccountRow, BalanceRow, EbSessionRow, Env, PsuType, TxRow } from "./types";

/**
 * D1 repository. The database is bound directly to the Worker — it has no
 * public endpoint and no credentials that can leak.
 */
export class Db {
  private d1: D1Database;

  constructor(env: Env) {
    this.d1 = env.DB;
  }

  // ---- sessions ----

  async activeSessions(): Promise<EbSessionRow[]> {
    const r = await this.d1
      .prepare("SELECT * FROM eb_sessions WHERE status = 'active' ORDER BY updated_at DESC")
      .all<EbSessionRow>();
    return r.results;
  }

  async allSessions(limit = 10): Promise<EbSessionRow[]> {
    const r = await this.d1
      .prepare("SELECT * FROM eb_sessions ORDER BY updated_at DESC LIMIT ?")
      .bind(limit)
      .all<EbSessionRow>();
    return r.results;
  }

  async sessionsNeedingWarning(): Promise<EbSessionRow[]> {
    const r = await this.d1
      .prepare("SELECT * FROM eb_sessions WHERE status IN ('active','expired')")
      .all<EbSessionRow>();
    return r.results;
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

  // ---- accounts ----

  async allAccounts(): Promise<AccountRow[]> {
    const r = await this.d1.prepare("SELECT * FROM accounts ORDER BY name").all<AccountRow>();
    return r.results;
  }

  async allAccountsWithBank(): Promise<Array<AccountRow & { aspsp_name: string | null }>> {
    const r = await this.d1
      .prepare(
        "SELECT a.*, s.aspsp_name FROM accounts a LEFT JOIN eb_sessions s ON s.id = a.session_pk ORDER BY s.aspsp_name, a.name"
      )
      .all<AccountRow & { aspsp_name: string | null }>();
    return r.results;
  }

  async accountsBySession(sessionPk: string, accountUid?: string): Promise<AccountRow[]> {
    if (accountUid) {
      const r = await this.d1
        .prepare("SELECT * FROM accounts WHERE session_pk = ? AND account_uid = ?")
        .bind(sessionPk, accountUid)
        .all<AccountRow>();
      return r.results;
    }
    const r = await this.d1.prepare("SELECT * FROM accounts WHERE session_pk = ?").bind(sessionPk).all<AccountRow>();
    return r.results;
  }

  async upsertAccounts(rows: AccountRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.d1.prepare(
      `INSERT INTO accounts (account_uid, session_pk, name, iban, currency, psu_type, product)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_uid) DO UPDATE SET
         session_pk = excluded.session_pk, name = excluded.name, iban = excluded.iban,
         currency = excluded.currency, psu_type = excluded.psu_type, product = excluded.product`
    );
    await this.d1.batch(rows.map((a) => stmt.bind(a.account_uid, a.session_pk, a.name, a.iban, a.currency, a.psu_type, a.product)));
  }

  /**
   * Prior-generation account rows that share this identity (same IBAN + currency + psu_type)
   * but sit under a different account_uid — the residue of earlier re-authorizations, since
   * Enable Banking mints a fresh uid on each auth. Oldest first, so the earliest-created row
   * survives on collapse. IBAN is the stable identity key; skip when it is absent.
   */
  async staleAccountGenerations(
    iban: string | null,
    currency: string | null,
    psuType: PsuType,
    keepUid: string
  ): Promise<string[]> {
    if (!iban) return [];
    const r = await this.d1
      .prepare(
        `SELECT account_uid FROM accounts
         WHERE iban = ? AND currency IS ? AND psu_type = ? AND account_uid != ?
         ORDER BY created_at ASC`
      )
      .bind(iban, currency, psuType, keepUid)
      .all<{ account_uid: string }>();
    return r.results.map((x) => x.account_uid);
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

  /** Idempotent insert; returns number of newly inserted rows. */
  async insertTransactionsIgnore(rows: TxRow[]): Promise<number> {
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
      for (const r of results) inserted += r.meta.changes ?? 0;
    }
    return inserted;
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
      where.push("(counterparty LIKE ? OR remittance_info LIKE ?)");
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    const sql = `SELECT * FROM ${table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY booking_date DESC, id DESC LIMIT ?`;
    params.push(opts.limit);
    const r = await this.d1.prepare(sql).bind(...params).all<TxRow & { id: number }>();
    return r.results;
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

  /** Fixed-window rate limiter. Returns true if the action is allowed. */
  async rateLimitOk(key: string, max: number, windowMs: number): Promise<boolean> {
    const row = await this.d1
      .prepare("SELECT count, window_start FROM rate_limit WHERE key = ?")
      .bind(key)
      .first<{ count: number; window_start: string }>();
    const now = Date.now();
    if (!row || now - new Date(row.window_start + "Z").getTime() > windowMs) {
      await this.d1
        .prepare(
          `INSERT INTO rate_limit (key, count, window_start) VALUES (?, 1, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET count = 1, window_start = datetime('now')`
        )
        .bind(key)
        .run();
      return true;
    }
    if (row.count >= max) return false;
    await this.d1.prepare("UPDATE rate_limit SET count = count + 1 WHERE key = ?").bind(key).run();
    return true;
  }
}
