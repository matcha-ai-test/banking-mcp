import type { Env } from "./types";
import { maskIban } from "./util";

interface ExportTxRow {
  booking_date: string;
  value_date: string | null;
  amount_cents: number;
  credit_debit: string;
  remittance_info: string | null;
}

export interface StatementAccount {
  account_uid: string;
  bank: string;
  name: string | null;
  iban: string | null;
  currency: string | null;
  psu_type: string;
  last_synced_at: string | null;
  balance_type: string | null;
  balance_cents: number | null;
  balance_fetched_at: string | null;
  transactions: {
    booking_date: string;
    value_date: string | null;
    text: string;
    amount_cents: number;
    balance_cents: number | null;
  }[];
}

/**
 * Bulk statement export from the D1 cache. Never calls the bank, so it costs
 * nothing against the PSD2 fetch budget.
 *
 * Per account: transactions since `since` plus a computed running balance per
 * row (`balance_cents`), walked backwards from the latest booked balance (ITBD).
 */
export async function buildStatementExport(
  env: Env,
  opts: { bank?: string; since?: string; accountUids?: string[] | null }
): Promise<{ generated_at: string; since: string; accounts: StatementAccount[] }> {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(opts.since ?? "") ? (opts.since as string) : "2025-01-01";
  const bankFilter = opts.bank;
  const uids = opts.accountUids ?? null;

  const where: string[] = [];
  const binds: string[] = [];
  if (bankFilter) {
    where.push("s.aspsp_name = ?");
    binds.push(bankFilter);
  }
  if (uids && uids.length) {
    where.push(`a.account_uid IN (${uids.map(() => "?").join(",")})`);
    binds.push(...uids);
  }

  const accounts = await env.DB.prepare(
    `SELECT a.account_uid, a.name, a.iban, a.currency, a.psu_type, a.last_synced_at,
            s.aspsp_name AS bank
       FROM accounts a JOIN eb_sessions s ON s.id = a.session_pk
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.iban`
  )
    .bind(...binds)
    .all<{
      account_uid: string;
      name: string | null;
      iban: string | null;
      currency: string | null;
      psu_type: string;
      last_synced_at: string | null;
      bank: string;
    }>();

  const out: StatementAccount[] = [];
  for (const acct of accounts.results) {
    const bal = await env.DB.prepare(
      `SELECT balance_type, amount_cents, fetched_at FROM balances
        WHERE account_uid = ?
        ORDER BY CASE balance_type WHEN 'ITBD' THEN 0 WHEN 'VALU' THEN 1 ELSE 2 END
        LIMIT 1`
    )
      .bind(acct.account_uid)
      .first<{ balance_type: string; amount_cents: number; fetched_at: string }>();

    const txs = await env.DB.prepare(
      `SELECT booking_date, value_date, amount_cents, credit_debit, remittance_info
         FROM transactions
        WHERE account_uid = ? AND booking_date >= ?
        ORDER BY booking_date DESC, id DESC`
    )
      .bind(acct.account_uid, since)
      .all<ExportTxRow>();

    let running = bal?.amount_cents ?? null;
    const rows = txs.results.map((t) => {
      const signed = t.credit_debit === "DBIT" ? -t.amount_cents : t.amount_cents;
      const balance = running;
      if (running !== null) running -= signed;
      return {
        booking_date: t.booking_date,
        value_date: t.value_date,
        text: t.remittance_info ?? "",
        amount_cents: signed,
        balance_cents: balance,
      };
    });

    out.push({
      account_uid: acct.account_uid,
      bank: acct.bank,
      name: acct.name,
      iban: maskIban(acct.iban),
      currency: acct.currency,
      psu_type: acct.psu_type,
      last_synced_at: acct.last_synced_at,
      balance_type: bal?.balance_type ?? null,
      balance_cents: bal?.amount_cents ?? null,
      balance_fetched_at: bal?.fetched_at ?? null,
      transactions: rows,
    });
  }

  return { generated_at: new Date().toISOString(), since, accounts: out };
}
