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
  account_identity_id TEXT REFERENCES account_identities(id) ON DELETE RESTRICT,
  -- Set when identity resolution failed closed for this row's current natural
  -- identity; the backfill skips the row until its inputs change or the
  -- operator resolves it (npm run identity:resolve).
  identity_conflict_key TEXT
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

-- Step 2: local categories, rules and manual overrides. Evaluated at read time;
-- no table references transactions or accounts rows, so re-authorization,
-- folding and pending replacement never delete a user decision.
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL UNIQUE CHECK (length(name_key) BETWEEN 1 AND 160),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categorization_rules (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  account_identity_id TEXT REFERENCES account_identities(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  direction TEXT NOT NULL CHECK (direction IN ('in','out','any')),
  counterparty_mode TEXT CHECK (counterparty_mode IN ('exact','contains')),
  counterparty_pattern TEXT,
  remittance_mode TEXT CHECK (remittance_mode IN ('exact','contains')),
  remittance_pattern TEXT,
  amount_min_cents INTEGER,
  amount_max_cents INTEGER,
  currency TEXT,
  booking_day_from INTEGER,
  booking_day_to INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((counterparty_mode IS NULL AND counterparty_pattern IS NULL) OR
    (counterparty_mode IS NOT NULL AND counterparty_pattern IS NOT NULL
      AND length(counterparty_pattern) BETWEEN 1 AND 160)),
  CHECK ((remittance_mode IS NULL AND remittance_pattern IS NULL) OR
    (remittance_mode IS NOT NULL AND remittance_pattern IS NOT NULL
      AND length(remittance_pattern) BETWEEN 1 AND 256)),
  CHECK (amount_min_cents IS NULL OR
    (typeof(amount_min_cents) = 'integer' AND amount_min_cents BETWEEN 0 AND 9007199254740991)),
  CHECK (amount_max_cents IS NULL OR
    (typeof(amount_max_cents) = 'integer' AND amount_max_cents BETWEEN 0 AND 9007199254740991)),
  CHECK (amount_min_cents IS NULL OR amount_max_cents IS NULL OR amount_min_cents <= amount_max_cents),
  CHECK (currency IS NULL OR (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')),
  CHECK ((amount_min_cents IS NULL AND amount_max_cents IS NULL) OR currency IS NOT NULL),
  CHECK ((booking_day_from IS NULL AND booking_day_to IS NULL) OR
    (booking_day_from IS NOT NULL AND booking_day_to IS NOT NULL
      AND booking_day_from BETWEEN 1 AND 31 AND booking_day_to BETWEEN 1 AND 31
      AND booking_day_from <= booking_day_to)),
  CHECK (account_identity_id IS NOT NULL OR counterparty_pattern IS NOT NULL OR
    remittance_pattern IS NOT NULL OR amount_min_cents IS NOT NULL OR amount_max_cents IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_rules_scope_priority
  ON categorization_rules(enabled, account_identity_id, priority DESC, created_at, id);
CREATE INDEX IF NOT EXISTS idx_rules_category ON categorization_rules(category_id);

CREATE TABLE IF NOT EXISTS transaction_category_overrides (
  account_identity_id TEXT NOT NULL REFERENCES account_identities(id) ON DELETE RESTRICT,
  transaction_key TEXT NOT NULL CHECK (
    length(transaction_key) = 64 AND transaction_key NOT GLOB '*[^0-9a-f]*'),
  category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  booking_date TEXT NOT NULL CHECK (length(booking_date) = 10),
  amount_cents INTEGER NOT NULL CHECK (
    typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 0 AND 9007199254740991),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  credit_debit TEXT NOT NULL CHECK (credit_debit IN ('CRDT','DBIT')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_identity_id, transaction_key)
);
CREATE INDEX IF NOT EXISTS idx_overrides_category ON transaction_category_overrides(category_id);
