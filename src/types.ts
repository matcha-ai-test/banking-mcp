export interface Env extends Cloudflare.Env {
  EB_APP_ID?: string;
  EB_PRIVATE_KEY?: string;
  MCP_SECRET?: string;
  START_TOKEN?: string;
}

export type PsuType = "personal" | "business";

export interface EbSessionRow {
  id: string;
  session_id: string;
  psu_type: PsuType;
  aspsp_name: string;
  aspsp_country: string;
  valid_until: string | null;
  status: string;
  refresh_count_today: number;
  refresh_count_date: string | null;
  renewal_due: number;
  backoff_until: string | null;
  last_live_verified_at: string | null;
  last_live_result: string | null;
  updated_at: string;
}

export interface AccountRow {
  account_uid: string;
  session_pk: string;
  name: string | null;
  iban: string | null;
  currency: string | null;
  psu_type: PsuType;
  product: string | null;
  last_synced_at: string | null;
}

export interface TxRow {
  account_uid: string;
  booking_date: string;
  value_date: string | null;
  amount_cents: number;
  currency: string;
  credit_debit: string;
  counterparty: string | null;
  remittance_info: string | null;
  entry_reference: string | null;
  dedup_key: string;
  raw: string | null;
}

export interface BalanceRow {
  account_uid: string;
  balance_type: string;
  amount_cents: number;
  currency: string;
  fetched_at: string;
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_amount: { currency: string; amount: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  [k: string]: unknown;
}

export interface EbBalance {
  name?: string;
  balance_amount: { currency: string; amount: string };
  balance_type?: string;
  [k: string]: unknown;
}

export interface EbAccount {
  uid: string;
  account_id?: { iban?: string | null } | null;
  currency?: string | null;
  name?: string | null;
  details?: string | null;
  product?: string | null;
  [k: string]: unknown;
}
