// Operator escape hatch for identity_conflict (see src/identity.ts). Pure SQL
// builders so the statements can be tested against a local SQLite copy; the
// CLI wrapper in scripts/identity-resolve.mjs only validates flags and runs
// them through wrangler. `wrangler d1 execute --command` takes no bind
// parameters, so every value that reaches SQL is whitelisted first and the
// whitelists admit no quote, semicolon, space or comment character.

/** Enable Banking account uids are UUIDs; allow any short alphanumeric/dash token. */
export const ACCOUNT_UID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** account_identities.id: 32 lowercase hex characters. */
export const IDENTITY_REF_RE = /^[0-9a-f]{32}$/;

export function validateAccountUid(uid) {
  if (typeof uid !== "string" || !ACCOUNT_UID_RE.test(uid)) throw new Error("--account-uid must be letters, digits and dashes (max 64)");
  return uid;
}

export function validateIdentityRef(ref) {
  if (typeof ref !== "string" || !IDENTITY_REF_RE.test(ref)) throw new Error("--identity must be a 32-character lowercase hex account_ref");
  return ref;
}

/** Rows the backfill has parked as conflicts. Shows only the IBAN's last four characters. */
export function listConflictsSql() {
  return `SELECT a.account_uid, a.name, s.aspsp_name AS bank, a.currency, a.psu_type,
  CASE WHEN a.iban IS NULL THEN NULL ELSE substr(replace(a.iban, ' ', ''), -4) END AS iban_last4,
  (SELECT i.id FROM account_identities i WHERE i.identification_hash = a.identification_hash
     AND i.currency = upper(coalesce(a.currency, '')) AND i.psu_type = a.psu_type) AS hash_identity
FROM accounts a LEFT JOIN eb_sessions s ON s.id = a.session_pk
WHERE a.account_identity_id IS NULL AND a.identity_conflict_key IS NOT NULL
ORDER BY a.created_at`;
}

/**
 * attach: point the row at an existing identity (its label then applies to the
 * row). When that identity has no IBAN yet it inherits the row's, so the next
 * re-authorization resolves by IBAN instead of conflicting again. Currency and
 * PSU type must match. Each statement is guarded, so a partial run is harmless
 * and a re-run is idempotent.
 */
export function attachSql(accountUid, identityRef) {
  const uid = validateAccountUid(accountUid);
  const ref = validateIdentityRef(identityRef);
  const matches = `EXISTS (SELECT 1 FROM accounts a WHERE a.account_uid = '${uid}' AND a.account_identity_id IS NULL
    AND upper(coalesce(a.currency, '')) = i.currency AND a.psu_type = i.psu_type)`;
  return [
    `UPDATE account_identities AS i SET iban = (SELECT upper(replace(a.iban, ' ', '')) FROM accounts a WHERE a.account_uid = '${uid}')
WHERE i.id = '${ref}' AND i.iban IS NULL AND ${matches}
  AND (SELECT a.iban FROM accounts a WHERE a.account_uid = '${uid}') IS NOT NULL`,
    `UPDATE accounts SET account_identity_id = '${ref}', identity_conflict_key = NULL
WHERE account_uid = '${uid}' AND account_identity_id IS NULL
  AND EXISTS (SELECT 1 FROM account_identities i WHERE i.id = '${ref}'
    AND upper(coalesce(accounts.currency, '')) = i.currency AND accounts.psu_type = i.psu_type)`,
  ];
}

/**
 * new: give the row a fresh identity carrying only its IBAN. The conflicting
 * hash stays with the identity that already owns it, together with that
 * identity's label; the new identity starts unlabelled.
 */
export function newIdentitySql(accountUid, newId) {
  const uid = validateAccountUid(accountUid);
  const id = validateIdentityRef(newId);
  return [
    `INSERT INTO account_identities (id, iban, identification_hash, currency, psu_type)
SELECT '${id}', upper(replace(iban, ' ', '')), NULL, upper(coalesce(currency, '')), psu_type FROM accounts
WHERE account_uid = '${uid}' AND account_identity_id IS NULL AND iban IS NOT NULL`,
    `UPDATE accounts SET account_identity_id = '${id}', identity_conflict_key = NULL
WHERE account_uid = '${uid}' AND account_identity_id IS NULL
  AND EXISTS (SELECT 1 FROM account_identities WHERE id = '${id}')`,
  ];
}

/** Fresh id in the account_identities.id format. */
export function newIdentityId() {
  return crypto.randomUUID().replaceAll("-", "");
}
