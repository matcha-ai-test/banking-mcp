CREATE TABLE IF NOT EXISTS eb_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  psu_type TEXT NOT NULL CHECK (psu_type IN ('personal','business')),
  aspsp_name TEXT NOT NULL DEFAULT 'unknown',
  aspsp_country TEXT NOT NULL DEFAULT 'SE',
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  refresh_count_today INTEGER NOT NULL DEFAULT 0,
  refresh_count_date TEXT,
  renewal_due INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  last_live_verified_at TEXT,
  last_live_result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  account_uid TEXT PRIMARY KEY,
  session_pk TEXT NOT NULL REFERENCES eb_sessions(id) ON DELETE CASCADE,
  name TEXT,
  iban TEXT,
  currency TEXT,
  psu_type TEXT NOT NULL,
  product TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid TEXT NOT NULL REFERENCES accounts(account_uid) ON DELETE CASCADE,
  booking_date TEXT NOT NULL,
  value_date TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  credit_debit TEXT NOT NULL,
  counterparty TEXT,
  remittance_info TEXT,
  entry_reference TEXT,
  dedup_key TEXT NOT NULL,
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_uid, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_tx_booking ON transactions(booking_date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_uid, booking_date DESC);

CREATE TABLE IF NOT EXISTS pending_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid TEXT NOT NULL,
  booking_date TEXT NOT NULL,
  value_date TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  credit_debit TEXT NOT NULL,
  counterparty TEXT,
  remittance_info TEXT,
  entry_reference TEXT,
  raw TEXT
);

CREATE TABLE IF NOT EXISTS balances (
  account_uid TEXT NOT NULL,
  balance_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_uid, balance_type)
);

CREATE TABLE IF NOT EXISTS auth_state (
  state TEXT PRIMARY KEY,
  psu_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  trigger_source TEXT,
  accounts_synced INTEGER,
  new_transactions INTEGER,
  status TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
