import type { Db } from "./db";
import { ExpiredSessionError, RateLimitError } from "./eb";
import type { EbClient } from "./eb";
import { REFRESH_BUDGET_PER_DAY } from "./mcp-output";
import type { TxRow } from "./types";
import { maskIban } from "./util";

export interface TransactionDetailsInput {
  booking_date: string;
  amount: number;
  transaction_id?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cachedRaw(row: TxRow): Record<string, unknown> {
  try { return object(JSON.parse(row.raw ?? "null")); } catch { return {}; }
}

function cachedDetailResponse(row: TxRow) {
  const raw = cachedRaw(row);
  if (row.detail_fetched_at == null && raw.detail == null) return null;
  return { ...(raw.detail != null ? sanitizeTransactionDetails(raw.detail) : sanitizeTransactionDetails(raw, row)),
    list_row: sanitizeTransactionDetails(raw, row), cached_detail: true };
}

function signed(cents: number, direction: unknown): number {
  return Number(((direction === "DBIT" ? -Math.abs(cents) : Math.abs(cents)) / 100).toFixed(2));
}

/** Allowlist scalar fields, including nested objects; never copy an upstream payload. */
export function sanitizeTransactionDetails(value: unknown, cached?: TxRow) {
  const raw = object(value);
  const amount = object(raw.transaction_amount);
  const numeric = typeof amount.amount === "string" && amount.amount.trim() !== ""
    ? Number(amount.amount) : NaN;
  return {
    booking_date: string(raw.booking_date) ?? cached?.booking_date ?? null,
    value_date: string(raw.value_date) ?? cached?.value_date ?? null,
    amount: Number.isFinite(numeric) ? signed(Math.round(numeric * 100), raw.credit_debit_indicator)
      : cached ? signed(cached.amount_cents, cached.credit_debit) : null,
    currency: string(amount.currency) ?? cached?.currency ?? null,
    status: string(raw.status),
    remittance_information: Array.isArray(raw.remittance_information)
      ? raw.remittance_information.filter((v): v is string => typeof v === "string") : [],
    creditor_name: string(object(raw.creditor).name),
    debtor_name: string(object(raw.debtor).name),
    creditor_account_iban: maskIban(string(object(raw.creditor_account).iban)),
    debtor_account_iban: maskIban(string(object(raw.debtor_account).iban)),
    note: string(raw.note),
    bank_transaction_code: { description: string(object(raw.bank_transaction_code).description) },
    reference_number: string(raw.reference_number),
    merchant_category_code: string(raw.merchant_category_code),
  };
}

/** Cached details are free; otherwise charge once, fetch once and persist. */
export async function readTransactionDetails(
  db: Db,
  createClient: () => Pick<EbClient, "prepare" | "getTransactionDetail">,
  input: TransactionDetailsInput,
  accountUids: string[] | null = null,
  nowMs = Date.now()
) {
  const rows = await db.findTransactionDetails({ transactionId: input.transaction_id,
    bookingDate: input.booking_date, amountCents: Math.round(input.amount * 100), accountUids });
  if (rows.length === 0) return { error: "No cached transaction matches" };
  if (rows.length > 1) return {
    error: "Multiple cached transactions match; pass transaction_id and an account filter if needed",
    candidates: rows.map((row) => ({ date: row.booking_date,
      amount: signed(row.amount_cents, row.credit_debit), description: row.remittance_info,
      transaction_id: string(cachedRaw(row).transaction_id) })),
  };
  const row = rows[0];
  const raw = cachedRaw(row);
  const listRow = sanitizeTransactionDetails(raw, row);
  const cached = cachedDetailResponse(row);
  if (cached) return cached;
  const transactionId = string(raw.transaction_id);
  if (!transactionId) return {
    error: "This bank did not provide a transaction_id; no additional details are available", cached: listRow,
  };
  const account = (await db.allAccounts()).find((a) => a.account_uid === row.account_uid);
  const session = (await db.activeSessions()).find((s) => s.id === account?.session_pk);
  if (!session) return { error: "no_active_session" };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  let client;
  try {
    client = createClient();
  } catch {
    return { error: "client_not_configured" };
  }
  try {
    await client.prepare();
  } catch {
    return { error: "key_invalid" };
  }
  const preparedRow = await db.persistedTransaction(row);
  if (!preparedRow) return { error: "No cached transaction matches" };
  const preparedCache = cachedDetailResponse(preparedRow);
  if (preparedCache) return preparedCache;
  const claimedAt = new Date(nowMs).toISOString();
  if (!await db.claimTransactionDetail(preparedRow.id, claimedAt, new Date(nowMs - 120_000).toISOString())) {
    // A competing caller owns dispatch. Wait briefly for its persisted result,
    // without charging this caller or issuing another HTTP request.
    for (let poll = 0; poll <= 30; poll++) {
      if (poll > 0) await new Promise(resolve => setTimeout(resolve, 100));
      const winner = await db.persistedTransaction(row);
      const winnerCache = winner && cachedDetailResponse(winner);
      if (winnerCache) return winnerCache;
    }
    return { error: "detail_fetch_in_progress" };
  }
  try {
    const budget = await db.tryChargeRefreshBudget(session.id, today, REFRESH_BUDGET_PER_DAY);
    if (!budget.charged) return {
      error: `Daily refresh budget (${REFRESH_BUDGET_PER_DAY}) used; serving cached data. Budget resets at midnight UTC.`,
      budget_left_today: 0,
    };
    const current = await db.persistedTransaction(row);
    if (!current) return { error: "No cached transaction matches" };
    const currentCache = cachedDetailResponse(current);
    if (currentCache) return currentCache;
    let detail = await client.getTransactionDetail(row.account_uid, transactionId);
    detail = await db.storeTransactionDetail(current, detail);
    return { ...sanitizeTransactionDetails(detail), list_row: listRow,
      budget_left_today: REFRESH_BUDGET_PER_DAY - budget.count };
  } catch (error) {
    return { error: error instanceof ExpiredSessionError ? "expired_session"
      : error instanceof RateLimitError ? "rate_limited" : "transaction_details_failed" };
  } finally {
    await db.releaseTransactionDetailClaim(preparedRow.id, claimedAt);
  }
}
