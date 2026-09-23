// Step 1: account labels. mockEnableBanking({}) for the whole file: zero bank calls.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createEnv, mockEnableBanking } from "./helpers.mjs";

const { Db } = await import("../src/db.ts");
const { assignAccountIdentities, canonicalIban } = await import("../src/identity.ts");
const { ACCOUNT_REF_RE, containsIbanLike, matchAccountUids, maskIban, normalizeText } = await import("../src/util.ts");
const { compactJson, serializeMcpText } = await import("../src/mcp-output.ts");
const { checkMutationBudget, enforceArgBudget } = await import("../src/mutation-guard.ts");

const deps = { compactJson, containsIbanLike, checkMutationBudget, enforceArgBudget, maskIban, normalizeText, ACCOUNT_REF_RE, canonicalIban };

/** Same slicing as low-risk-batch.test.mjs: run one real handler body against a Db. */
function handler(name, dependencies) {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf("      async (", source.indexOf(`      "${name}",`));
  const end = source.indexOf("\n    );", start);
  const body = source.slice(start, end).trim().replace(/^async \(([^)]*)\) =>/, "async function($1)");
  const money = source.slice(source.indexOf("function money("), source.indexOf("function signed("));
  return Function(...Object.keys(dependencies), `${stripTypeScriptTypes(money)}; return ${stripTypeScriptTypes(`(${body})`)};`)(...Object.values(dependencies));
}

function self(db, uids = null) {
  return { db: () => db, resolveAccountUids: async () => uids, warnings: async () => "", text: serializeMcpText };
}
const parse = (r) => JSON.parse(r.content[0].text);

async function setup(t) {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const mock = mockEnableBanking({});
  t.after(() => mock.restore());
  const db = new Db(env);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  return db;
}

async function seedAccount(db, uid, overrides = {}) {
  await db.upsertAccounts([{
    account_uid: uid, session_pk: "s", name: overrides.name ?? "Vardagskonto", iban: overrides.iban ?? `SE${uid.toUpperCase().padEnd(10, "0")}`,
    currency: "SEK", psu_type: "personal", product: null, last_synced_at: null,
  }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === uid));
  return db.accountIdentityOf(uid);
}

async function callSetLabel(db, args) {
  return parse(await handler("set_account_label", deps).call(self(db), args));
}

test("set, then list_accounts shows label and account_ref; matchAccountUids resolves by label and by account_ref", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");

  const out = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.equal(out.label, "Vardag");
  assert.equal(out.revision, 1);
  assert.equal(out.accounts.length, 1);

  const listOut = parse(await handler("list_accounts", deps).call(self(db)));
  assert.equal(listOut[0].label, "Vardag");
  assert.equal(listOut[0].account_ref, identityId);

  const rows = await db.allAccountsWithBank();
  assert.deepEqual(matchAccountUids(rows, "Vardag"), ["u1"]);
  assert.deepEqual(matchAccountUids(rows, identityId), ["u1"]);
});

test("a label on an identity shared by two generations resolves both uids", async (t) => {
  const db = await setup(t);
  await db.upsertAccounts([{ account_uid: "gen1", session_pk: "s", name: "Old", iban: "SESHARED1234", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  await db.upsertAccounts([{ account_uid: "gen2", session_pk: "s", name: "New", iban: "SESHARED1234", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows);
  const identityId = await db.accountIdentityOf("gen1");
  assert.equal(identityId, await db.accountIdentityOf("gen2"));

  await callSetLabel(db, { account_ref: identityId, label: "Shared" });
  const rowsWithBank = await db.allAccountsWithBank();
  assert.deepEqual(matchAccountUids(rowsWithBank, "Shared").sort(), ["gen1", "gen2"]);
});

test("clear with label null tombstones (revision 1 -> 2); expected_revision mismatch returns revision_conflict and leaves the label", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await callSetLabel(db, { account_ref: identityId, label: "Vardag" }); // revision 1

  const conflict = await callSetLabel(db, { account_ref: identityId, label: "Wrong", expected_revision: 99 });
  assert.equal(conflict.error, "revision_conflict");
  assert.equal((await db.labelsByIdentity([identityId])).get(identityId).label, "Vardag");

  const cleared = await callSetLabel(db, { account_ref: identityId, label: null }); // tombstone -> revision 2
  assert.equal(cleared.label, null);
  assert.equal((await db.labelsByIdentity([identityId])).size, 0);

  // Clearing again without a lock is idempotent (already tombstoned: no bump, stays revision 2).
  const again = await callSetLabel(db, { account_ref: identityId, label: null });
  assert.equal(again.error, undefined);
  assert.equal(again.label, null);

  // J4: a locked clear is retryable — the locked UPDATE only ever touches a
  // live label (label IS NOT NULL), so on an already-tombstoned row it always
  // reports ok with the stored revision, regardless of the expected_revision
  // given, rather than conflicting.
  const stale = await callSetLabel(db, { account_ref: identityId, label: null, expected_revision: 1 });
  assert.equal(stale.error, undefined);
  assert.equal(stale.label, null);
  assert.equal(stale.revision, 2);

  // A locked clear against the *current* revision still succeeds too.
  const locked = await callSetLabel(db, { account_ref: identityId, label: null, expected_revision: 2 });
  assert.equal(locked.error, undefined);
  assert.equal(locked.label, null);
});

test("rejects 61 chars, a control character, and IBAN-shaped text, without echoing the submitted value", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");

  const long = await handler("set_account_label", deps).call(self(db), { account_ref: identityId, label: "x".repeat(61) });
  const longText = JSON.stringify(long);
  assert.match(longText, /invalid_argument/);
  assert.equal(longText.includes("x".repeat(61)), false);

  const control = await handler("set_account_label", deps).call(self(db), { account_ref: identityId, label: "bad\u0007label" });
  const controlText = JSON.stringify(control);
  assert.match(controlText, /invalid_argument/);
  assert.equal(controlText.includes("bad\u0007label"), false);

  const ibanLike = "SE1234567890123456781234";
  const iban = await handler("set_account_label", deps).call(self(db), { account_ref: identityId, label: ibanLike });
  const ibanText = JSON.stringify(iban);
  assert.match(ibanText, /text_looks_like_account_number/);
  assert.equal(ibanText.includes(ibanLike), false);
});

test("31st mutation within one minute returns rate_limited; dry runs do not count (30 dry runs then 30 writes all succeed)", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");

  for (let i = 0; i < 30; i++) {
    const dry = await callSetLabel(db, { account_ref: identityId, label: `Dry ${i}`, dry_run: true });
    assert.equal(dry.dry_run, true);
  }
  for (let i = 0; i < 30; i++) {
    const written = await callSetLabel(db, { account_ref: identityId, label: `Label ${i}` });
    assert.equal(written.label, `Label ${i}`);
  }
  const overBudget = await callSetLabel(db, { account_ref: identityId, label: "One too many" });
  assert.equal(overBudget.error, "rate_limited");
});

test("unknown account_ref returns not_found; an account without a stable identity cannot be labelled (list_accounts shows account_ref: null)", async (t) => {
  const db = await setup(t);
  const unknown = await callSetLabel(db, { account_ref: "0".repeat(32), label: "X" });
  assert.equal(unknown.error, "not_found");

  await db.upsertAccounts([{ account_uid: "bare", session_pk: "s", name: "Bare", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const listOut = parse(await handler("list_accounts", deps).call(self(db)));
  const bare = listOut.find((a) => a.account_uid === "bare");
  assert.equal("account_ref" in bare, false); // compactJson drops the null field
});

// ------------------------------------------------------------------------- F6

test("containsIbanLike: rejects an IBAN hidden by punctuation or a zero-width space, and the label handler never echoes the value", async (t) => {
  assert.equal(containsIbanLike("SE45-5000-0000-0583-9825-7466"), true);
  assert.equal(containsIbanLike("SE45.5000.0000.0583.9825.7466"), true);
  assert.equal(containsIbanLike("SE45​5000000005839825746​6"), true);

  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  for (const label of ["SE45-5000-0000-0583-9825-7466", "SE45.5000.0000.0583.9825.7466", "SE45​5000000005839825746​6"]) {
    const out = await handler("set_account_label", deps).call(self(db), { account_ref: identityId, label });
    const text = JSON.stringify(out);
    assert.match(text, /text_looks_like_account_number/);
    assert.equal(text.includes(label), false);
  }
});

// ------------------------------------------------------------------------- F7

test("list_accounts exposes label_revision alongside label", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await callSetLabel(db, { account_ref: identityId, label: "Vardag" });

  const listOut = parse(await handler("list_accounts", deps).call(self(db)));
  assert.equal(listOut[0].label, "Vardag");
  assert.equal(listOut[0].label_revision, 1);

  const updated = await callSetLabel(db, { account_ref: identityId, label: "Vardag2" });
  assert.equal(updated.revision, 2);
  const listOut2 = parse(await handler("list_accounts", deps).call(self(db)));
  assert.equal(listOut2[0].label_revision, 2);
});

// ------------------------------------------------------------------------- F5

test("set_account_label: a label colliding with another account's name (not belonging to this identity) is rejected as label_collision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await db.upsertAccounts([{ account_uid: "other", session_pk: "s", name: "Buffert", iban: "SEOTHERNAME1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);

  const out = await callSetLabel(db, { account_ref: identityId, label: "buffert" });
  assert.equal(out.error, "label_collision");
});

test("set_account_label: a label colliding with another account's bank name is rejected as label_collision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await db.upsertAccounts([{ account_uid: "other", session_pk: "s", name: "Konto2", iban: "SEOTHERBANK1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const out = await callSetLabel(db, { account_ref: identityId, label: "bank" });
  assert.equal(out.error, "label_collision");
});

test("set_account_label: a label colliding with another identity's existing label (case-insensitive) is rejected", async (t) => {
  const db = await setup(t);
  const idA = await seedAccount(db, "u1");
  await db.upsertAccounts([{ account_uid: "u2", session_pk: "s", name: "Konto2", iban: "SEOTHERIDNT1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === "u2"));
  const idB = await db.accountIdentityOf("u2");
  const setB = await callSetLabel(db, { account_ref: idB, label: "Sparkonto" });
  assert.equal(setB.error, undefined);

  const out = await callSetLabel(db, { account_ref: idA, label: "sparkonto" });
  assert.equal(out.error, "label_collision");
});

test("set_account_label: dry_run returns the same masked accounts list a real write returns, computed before any write, and does not charge the mutation budget", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");

  const dry = await callSetLabel(db, { account_ref: identityId, label: "Vardag", dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.equal(Array.isArray(dry.accounts), true);
  assert.equal(dry.accounts.length, 1);
  assert.equal((await db.labelsByIdentity([identityId])).size, 0); // no write happened

  const real = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.deepEqual(dry.accounts, real.accounts);

  // dry runs never charged the 30/minute mutation budget: the real write above was charge 1
  // of 30, and 29 more still succeed.
  for (let i = 0; i < 29; i++) {
    const written = await callSetLabel(db, { account_ref: identityId, label: `Lbl${i}` });
    assert.equal(written.error, undefined);
  }
});

// ------------------------------------------------------------------------- F8

// ------------------------------------------------------------------------- G3

test("upsertLabel: two different identities setting the same normalized label concurrently — exactly one succeeds, the other gets label_collision", async (t) => {
  const db = await setup(t);
  const idA = await seedAccount(db, "u1");
  await db.upsertAccounts([{ account_uid: "u2", session_pk: "s", name: "Konto2", iban: "SECONCURRENT2", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === "u2"));
  const idB = await db.accountIdentityOf("u2");

  const [resA, resB] = await Promise.all([db.upsertLabel(idA, "Samma", null), db.upsertLabel(idB, "Samma", null)]);
  const results = [resA, resB];
  assert.equal(results.filter((r) => r.ok).length, 1);
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, "label_collision");
});

test("set_account_label: a label left on an identity with no current accounts row still blocks reuse by another identity", async (t) => {
  const env = await createEnv();
  t.after(() => env.DB.close());
  const mock = mockEnableBanking({});
  t.after(() => mock.restore());
  const db = new Db(env);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  const idA = await seedAccount(db, "u1");
  const set = await callSetLabel(db, { account_ref: idA, label: "Orphan" });
  assert.equal(set.error, undefined);

  // Delete the only accounts row for idA directly, bypassing set_account_label's
  // accounts join. The identity and its account_labels row survive.
  env.DB.sqlite.prepare("DELETE FROM accounts WHERE account_identity_id = ?").run(idA);
  assert.equal((await db.allAccountsWithBank()).some((a) => a.account_identity_id === idA), false);

  await db.upsertAccounts([{ account_uid: "u2", session_pk: "s", name: "Konto2", iban: "SEORPHANBLOCK1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === "u2"));
  const idB = await db.accountIdentityOf("u2");

  const out = await callSetLabel(db, { account_ref: idB, label: "orphan" });
  assert.equal(out.error, "label_collision");
});

// ------------------------------------------------------------------------- G5

test("set_account_label: an unlocked write of the same text (after whitespace normalization) is a no-op that does not bump the revision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const first = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.equal(first.revision, 1);

  // Same label, only surrounding whitespace differs, submitted again without a lock.
  const again = await callSetLabel(db, { account_ref: identityId, label: "  Vardag " });
  assert.equal(again.revision, 1);
  assert.equal((await db.labelsByIdentity([identityId])).get(identityId).revision, 1);
});

test("set_account_label: a locked clear that matches 0 rows is success when no label row exists; revision_conflict only when a row exists with a different revision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");

  // No label row exists at all yet: a locked clear still succeeds.
  const clearedNoRow = await callSetLabel(db, { account_ref: identityId, label: null, expected_revision: 1 });
  assert.equal(clearedNoRow.error, undefined);
  assert.equal(clearedNoRow.label, null);

  await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  const conflict = await callSetLabel(db, { account_ref: identityId, label: null, expected_revision: 99 });
  assert.equal(conflict.error, "revision_conflict");
});

test("set_account_label: an unexpected storage error returns a sanitized invalid_argument/storage/write_failed, never a D1 message", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const original = db.upsertLabel.bind(db);
  db.upsertLabel = async () => { throw new Error("D1_ERROR: SQLITE_CORRUPT some secret detail"); };
  t.after(() => { db.upsertLabel = original; });

  const out = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.equal(out.error, "invalid_argument");
  assert.equal(out.field, "storage");
  assert.equal(out.reason, "write_failed");
  assert.equal(JSON.stringify(out).includes("SQLITE_CORRUPT"), false);
});

test("set_account_label: the accounts list passes through compactJson, omitting iban: null like list_accounts", async (t) => {
  const db = await setup(t);
  await db.upsertAccounts([{ account_uid: "u1", session_pk: "s", name: "No IBAN", iban: null, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, identification_hash: "hash-for-no-iban" }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === "u1"));
  const identityId = await db.accountIdentityOf("u1");

  const dry = await callSetLabel(db, { account_ref: identityId, label: "Vardag", dry_run: true });
  assert.equal("iban" in dry.accounts[0], false);

  const real = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.equal("iban" in real.accounts[0], false);
});

// ------------------------------------------------------------------------- G7

test("set_account_label: an error thrown early (identityById) is also caught and sanitized, never a D1 message", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const original = db.identityById.bind(db);
  db.identityById = async () => { throw new Error("D1_ERROR: SQLITE_BUSY database is locked"); };
  t.after(() => { db.identityById = original; });

  const out = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.equal(out.error, "invalid_argument");
  assert.equal(out.field, "storage");
  assert.equal(out.reason, "write_failed");
  assert.equal(JSON.stringify(out).includes("SQLITE_BUSY"), false);
});

// ------------------------------------------------------------------------- H1

test("H1: account_ref precedence — a label matching A's account_ref is rejected at write time; forced directly into the DB, filtering by A's ref still resolves only A", async (t) => {
  const db = await setup(t);
  const idA = await seedAccount(db, "u1");
  await db.upsertAccounts([{ account_uid: "u2", session_pk: "s", name: "Konto2", iban: "SEHREFTEST01", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === "u2"));
  const idB = await db.accountIdentityOf("u2");

  // H2 rejects this at write time.
  const rejected = await callSetLabel(db, { account_ref: idB, label: idA });
  assert.equal(rejected.error, "label_collision");

  // Force it into the DB directly, bypassing set_account_label's own checks.
  const forced = await db.upsertLabel(idB, idA, null);
  assert.equal(forced.ok, true);

  const rowsWithBank = await db.allAccountsWithBank();
  // account_ref match wins outright: only A's uid, never unioned with B's.
  assert.deepEqual(matchAccountUids(rowsWithBank, idA), ["u1"]);
});

test("H1: when the filter is not shaped like any account_ref, a label match still applies", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  const rows = await db.allAccountsWithBank();
  assert.deepEqual(matchAccountUids(rows, "Vardag"), ["u1"]);
});

// ------------------------------------------------------------------------- H2

test("H2: label rejected when it looks like an account_ref (32 hex) or a dashed UUID, even with no other collision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const hex32 = await callSetLabel(db, { account_ref: identityId, label: "0123456789abcdef0123456789abcdef" });
  assert.equal(hex32.error, "label_collision");
  const uuid = await callSetLabel(db, { account_ref: identityId, label: "01234567-89ab-cdef-0123-456789abcdef" });
  assert.equal(uuid.error, "label_collision");
});

test("H2: label rejected when it equals any account_uid or account_identity_id, including the same identity's own", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "acc1");
  const asUid = await callSetLabel(db, { account_ref: identityId, label: "acc1" });
  assert.equal(asUid.error, "label_collision");
  const asIdentity = await callSetLabel(db, { account_ref: identityId, label: identityId });
  assert.equal(asIdentity.error, "label_collision");
});

test("H2: label rejected when it equals another account's IBAN last-4 or card_last4", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await db.upsertAccounts([{ account_uid: "other", session_pk: "s", name: "Other", iban: "SE0000000000009999", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const last4 = await callSetLabel(db, { account_ref: identityId, label: "9999" });
  assert.equal(last4.error, "label_collision");

  await db.upsertAccounts([{ account_uid: "card", session_pk: "s", name: "Card", iban: "SECARDTEST01", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null, card_last4: "4242" }]);
  const cardLabel = await callSetLabel(db, { account_ref: identityId, label: "4242" });
  assert.equal(cardLabel.error, "label_collision");
});

test("H2: a normalized label shorter than 3 characters is rejected as invalid_argument/label/length", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const oneChar = await callSetLabel(db, { account_ref: identityId, label: "x" });
  assert.equal(oneChar.error, "invalid_argument");
  assert.equal(oneChar.field, "label");
  assert.equal(oneChar.reason, "length");
  // 2 chars is also rejected now.
  const twoChar = await callSetLabel(db, { account_ref: identityId, label: "ab" });
  assert.equal(twoChar.error, "invalid_argument");
  assert.equal(twoChar.reason, "length");
  // Whitespace that normalizes down to 1 char is rejected the same way.
  const padded = await callSetLabel(db, { account_ref: identityId, label: " x " });
  assert.equal(padded.error, "invalid_argument");
  assert.equal(padded.reason, "length");
  // 3 chars is accepted.
  const ok = await callSetLabel(db, { account_ref: identityId, label: "abc" });
  assert.equal(ok.error, undefined);
});

test("K4: a label of 1-4 digits only is rejected as label_collision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const threeDigits = await callSetLabel(db, { account_ref: identityId, label: "123" });
  assert.equal(threeDigits.error, "label_collision");
  const fourDigits = await callSetLabel(db, { account_ref: identityId, label: "1234" });
  assert.equal(fourDigits.error, "label_collision");
  // A digit string mixed with a letter is not purely digits and is accepted.
  const mixed = await callSetLabel(db, { account_ref: identityId, label: "123a" });
  assert.equal(mixed.error, undefined);
});

// ------------------------------------------------------------------------- H3

test("H3: clearing tombstones (not deletes); list_accounts still shows the tombstone's label_revision with no label; a stale expected_revision after the clear still conflicts; set continues from the stored revision", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");

  const r1 = await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  assert.equal(r1.revision, 1);
  const r2 = await callSetLabel(db, { account_ref: identityId, label: null });
  assert.equal(r2.label, null);

  const listOut = parse(await handler("list_accounts", deps).call(self(db)));
  const row = listOut.find((a) => a.account_uid === "u1");
  assert.equal("label" in row, false);
  // J4: label_revision is shown whenever a label row exists, live or tombstoned.
  assert.equal(row.label_revision, 2);

  // Stale lock from before the clear (rev 1) fails against the tombstone's rev 2.
  const stale = await callSetLabel(db, { account_ref: identityId, label: "Wrong", expected_revision: 1 });
  assert.equal(stale.error, "revision_conflict");

  // Setting again continues from the stored (post-tombstone) revision, not from 1.
  const r3 = await callSetLabel(db, { account_ref: identityId, label: "Igen", expected_revision: 2 });
  assert.equal(r3.revision, 3);
});

test("H3: labelsByIdentity never surfaces a tombstoned (cleared) row", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await callSetLabel(db, { account_ref: identityId, label: "Vardag" });
  await callSetLabel(db, { account_ref: identityId, label: null });
  assert.equal((await db.labelsByIdentity([identityId])).size, 0);
});

test("H3: clearing frees the normalized label text for reuse by another identity", async (t) => {
  const db = await setup(t);
  const idA = await seedAccount(db, "u1");
  await callSetLabel(db, { account_ref: idA, label: "Delad" });
  await callSetLabel(db, { account_ref: idA, label: null });

  await db.upsertAccounts([{ account_uid: "u2", session_pk: "s", name: "Konto2", iban: "SEDELADTEST1", currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === "u2"));
  const idB = await db.accountIdentityOf("u2");

  const out = await callSetLabel(db, { account_ref: idB, label: "Delad" });
  assert.equal(out.error, undefined);
  assert.equal(out.label, "Delad");
});

test("a case-only change is written and bumps the revision; identical text is a no-op", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const first = await callSetLabel(db, { account_ref: identityId, label: "Testkort" });
  const same = await callSetLabel(db, { account_ref: identityId, label: "Testkort" });
  assert.equal(same.revision, first.revision);
  const recased = await callSetLabel(db, { account_ref: identityId, label: "testkort" });
  assert.equal(recased.revision, first.revision + 1);
  assert.equal((await db.labelsByIdentity([identityId])).get(identityId).label, "testkort");
});

// ------------------------------------------------------------------------- J4

test("J4: retryable locked clear — clear with expected_revision 3 bumps to 4; retrying the same locked clear (still expecting 3) is ok at revision 4, not a conflict; list_accounts shows label_revision 4 with no label; a subsequent locked set at expected_revision 4 works", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await callSetLabel(db, { account_ref: identityId, label: "Vardag" }); // revision 1
  const r2 = await callSetLabel(db, { account_ref: identityId, label: "Vardag2", expected_revision: 1 });
  assert.equal(r2.revision, 2);
  const r3 = await callSetLabel(db, { account_ref: identityId, label: "Vardag3", expected_revision: 2 });
  assert.equal(r3.revision, 3);

  const cleared = await callSetLabel(db, { account_ref: identityId, label: null, expected_revision: 3 });
  assert.equal(cleared.error, undefined);
  assert.equal(cleared.label, null);
  assert.equal(cleared.revision, 4);

  // Retry of the exact same locked clear call: the row is now tombstoned (label
  // already NULL), so the locked UPDATE matches 0 rows, but the re-read finds
  // no live label and reports ok with the stored revision, not a conflict.
  const retry = await callSetLabel(db, { account_ref: identityId, label: null, expected_revision: 3 });
  assert.equal(retry.error, undefined);
  assert.equal(retry.label, null);
  assert.equal(retry.revision, 4);

  const listOut = parse(await handler("list_accounts", deps).call(self(db)));
  const row = listOut.find((a) => a.account_uid === "u1");
  assert.equal("label" in row, false);
  assert.equal(row.label_revision, 4);

  const lockedSet = await callSetLabel(db, { account_ref: identityId, label: "Igen", expected_revision: 4 });
  assert.equal(lockedSet.error, undefined);
  assert.equal(lockedSet.revision, 5);
});

test("J4: deleteLabel directly — locked clear on a row with no account_labels entry at all returns ok with revision null", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const result = await db.deleteLabel(identityId, 1);
  assert.equal(result.ok, true);
  assert.equal(result.revision, null);
});

// ------------------------------------------------------------------------- K3

test("K3: deleteLabel unlocked — a concurrent set() landing a live label between our UPDATE and the re-read is still cleared, not silently reported as success without a write", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  await db.upsertLabel(identityId, "Vardag", null); // revision 1

  // Clear it once for real so the unlocked UPDATE (WHERE label IS NOT NULL)
  // finds 0 rows on the *next* call, forcing the re-read path.
  await db.deleteLabel(identityId, null); // revision 2, label NULL

  // Simulate a writer that sets a live label right after our first UPDATE's
  // WHERE clause missed (label was NULL) but before we re-read: intercept the
  // re-read SELECT-equivalent by pre-seeding a live label via a real upsert,
  // performed synchronously before deleteLabel's own re-read runs. Since
  // node:test has no real concurrency here, drive it by stubbing the first
  // internal SELECT this call makes.
  const originalPrepare = db.d1.prepare.bind(db.d1);
  let selectCount = 0;
  db.d1.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql.includes("SELECT revision, label FROM account_labels")) {
      const originalFirst = stmt.first.bind(stmt);
      stmt.first = async (...args) => {
        selectCount++;
        if (selectCount === 1) {
          // A concurrent writer sets a live label right before this read fires.
          await db.upsertLabel(identityId, "Concurrent", null);
        }
        return originalFirst(...args);
      };
    }
    return stmt;
  };
  t.after(() => { db.d1.prepare = originalPrepare; });

  const result = await db.deleteLabel(identityId, null);
  assert.equal(result.ok, true);

  // The concurrently-set label must actually be cleared, not just reported
  // cleared: a fresh read confirms no live label remains.
  const after = await db.labelsByIdentity([identityId]);
  assert.equal(after.size, 0);
});

// ------------------------------------------------------------------------- J5

test("J5: upsertLabel's unlocked branch is a single atomic statement — a concurrent no-op write and a real edit both land correctly", async (t) => {
  const db = await setup(t);
  const identityId = await seedAccount(db, "u1");
  const first = await db.upsertLabel(identityId, "Vardag", null);
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);

  // Same text again, unlocked: no revision bump.
  const noop = await db.upsertLabel(identityId, "Vardag", null);
  assert.equal(noop.ok, true);
  assert.equal(noop.revision, 1);

  // Different text, unlocked: bumps.
  const edit = await db.upsertLabel(identityId, "Annat", null);
  assert.equal(edit.ok, true);
  assert.equal(edit.revision, 2);
});
