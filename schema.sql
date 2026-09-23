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
  live_verify_claimed_at TEXT NULL,
  live_verify_result TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_identities (
  id TEXT PRIMARY KEY,
  iban TEXT,
  identification_hash TEXT,
  currency TEXT NOT NULL,
  psu_type TEXT NOT NULL CHECK (psu_type IN ('personal','business')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (iban IS NOT NULL OR identification_hash IS NOT NULL),
  CHECK (iban IS NULL OR length(iban) BETWEEN 5 AND 34),
  CHECK (identification_hash IS NULL OR length(identification_hash) BETWEEN 1 AND 2048),
  CHECK (currency = '' OR (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_iban
  ON account_identities(iban, currency, psu_type) WHERE iban IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_hash
  ON account_identities(identification_hash, currency, psu_type) WHERE identification_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounts (
  account_uid TEXT PRIMARY KEY,
  session_pk TEXT NOT NULL REFERENCES eb_sessions(id) ON DELETE CASCADE,
  name TEXT,
  iban TEXT,
  currency TEXT,
  psu_type TEXT NOT NULL,
  product TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cash_account_type TEXT,
  credit_limit_cents INTEGER,
  usage TEXT,
  bic TEXT,
  card_last4 TEXT,
  identification_hash TEXT,
  account_identity_id TEXT REFERENCES account_identities(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_accounts_identity ON accounts(account_identity_id);

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
  detail_fetched_at TEXT,
  detail_claimed_at TEXT,
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

CREATE TABLE IF NOT EXISTS aspsp_cache (
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  psu_types TEXT,
  maximum_consent_validity INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (name, country)
);

CREATE TABLE IF NOT EXISTS account_labels (
  account_identity_id TEXT PRIMARY KEY REFERENCES account_identities(id) ON DELETE RESTRICT,
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  label_norm TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_labels_norm ON account_labels(label_norm);
