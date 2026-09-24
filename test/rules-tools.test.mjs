// Step 2: category/rule/override tools against the node:sqlite D1 shim.
// mockEnableBanking({}) throws on any non-Enable-Banking URL and records every
// Enable Banking call, so each test also proves zero bank calls.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createEnv, mockEnableBanking } from "./helpers.mjs";

const { Db } = await import("../src/db.ts");
const { assignAccountIdentities, transactionKey } = await import("../src/identity.ts");
const { compactJson, serializeMcpText } = await import("../src/mcp-output.ts");
const { buildStatementExport } = await import("../src/export.ts");
const cat = await import("../src/categories.ts");

const IBAN = "SE4550000000058398257466";

// ---- harness ----

function handler(name, dependencies) {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const start = source.indexOf("      async (", source.indexOf(`      "${name}",`));
  const end = source.indexOf("\n    );", start);
  const body = source.slice(start, end).trim()
    .replace("new Map<string, { currency: string; out: number; in: number; count: number }>()", "new Map()")
    .replace(/^async \(([^)]*)\) =>/, "async function($1)");
  const money = source.slice(source.indexOf("function money("), source.indexOf("export class BankingMCP"));
  return Function(...Object.keys(dependencies), `${stripTypeScriptTypes(money)}; return ${stripTypeScriptTypes(`(${body})`)};`)(...Object.values(dependencies));
}
const deps = { compactJson, ...cat };
const self = (db, uids = null) => ({ db: () => db, resolveAccountUids: async () => uids, warnings: async () => "", text: serializeMcpText });
const parse = (r) => JSON.parse(r.content[0].text);
const call = async (db, name, args) => parse(await handler(name, deps).call(self(db), args));

async function setup(t) {
  const env = await createEnv();
  const mock = mockEnableBanking({});
  const db = new Db(env);
  await db.insertSession({ id: "s", session_id: "u", psu_type: "personal", valid_until: null, aspsp_name: "Bank", aspsp_country: "SE" });
  // One hook, in a fixed order: every test in this file must stay cache-only.
  t.after(() => {
    try {
      assert.equal(mock.calls.length, 0, "no Enable Banking call");
      const s = env.DB.sqlite.prepare("SELECT refresh_count_today FROM eb_sessions").all();
      assert.ok(s.every((r) => r.refresh_count_today === 0), "no refresh budget charged");
    } finally {
      mock.restore();
      env.DB.close();
    }
  });
  return { env, db, mock };
}

async function seedAccount(db, uid, { iban = IBAN, name = "Everyday" } = {}) {
  await db.upsertAccounts([{ account_uid: uid, session_pk: "s", name, iban, currency: "SEK", psu_type: "personal", product: null, last_synced_at: null }]);
  const rows = await db.accountsWithoutIdentity();
  await assignAccountIdentities(db, rows.filter((r) => r.account_uid === uid));
  return db.accountIdentityOf(uid);
}

let dk = 0;
function tx(uid, overrides = {}) {
  dk++;
  return {
    account_uid: uid, booking_date: "2030-01-15", value_date: null, amount_cents: 12345, currency: "SEK", credit_debit: "DBIT",
    counterparty: "Example Grocery", remittance_info: "Card purchase", entry_reference: `ref-${dk}`, dedup_key: `er:ref-${dk}`, raw: "{}",
    ...overrides,
  };
}

async function seedBasic(t) {
  const ctx = await setup(t);
  const ref = await seedAccount(ctx.db, "acc1");
  await ctx.db.insertTransactionsIgnore([
    tx("acc1", { booking_date: "2030-01-20", counterparty: "Example Grocery", amount_cents: 12345, dedup_key: "er:g1" }),
    tx("acc1", { booking_date: "2030-01-25", counterparty: "Example Landlord", amount_cents: 850000, dedup_key: "er:rent" }),
    tx("acc1", { booking_date: "2030-01-26", counterparty: "Employer AB", amount_cents: 3000000, credit_debit: "CRDT", dedup_key: "er:salary" }),
  ]);
  return { ...ctx, ref };
}

async function newCategory(db, name) {
  const out = await cat.createCategory(db, { name });
  assert.ok(out.category_id, JSON.stringify(out));
  return out.category_id;
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const groceryRule = (category_id, extra = {}) => ({
  category_id, scope: { type: "all_accounts" }, direction: "out", counterparty: { mode: "contains", value: "grocery" }, ...extra,
});

async function transactions(db, input = {}) {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const signed = Function(`${stripTypeScriptTypes(source.slice(source.indexOf("function money("), source.indexOf("export class BankingMCP")))}; return signed;`)();
  return parse(await handler("get_transactions", { ...deps, signed }).call(self(db), { limit: 100, include_pending: true, ...input }));
}
const byCounterparty = (out, name) => out.booked.find((r) => r.counterparty === name);

function snapshot(env) {
  const tables = env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, env.DB.sqlite.prepare(`SELECT * FROM ${name}`).all()]));
}

// ---- registration ----

const NEW_TOOLS = ["create_category", "rename_category", "list_categories", "add_rule", "update_rule", "list_rules",
  "delete_rule", "preview_rule", "categorize_transaction", "clear_transaction_category"];

test("every new tool is registered once with the indentation the handler-slicing tests rely on", () => {
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  for (const name of NEW_TOOLS) {
    assert.equal(source.split(`\n      "${name}",\n`).length, 2, name);
    const start = source.indexOf("      async (", source.indexOf(`      "${name}",`));
    assert.ok(source.indexOf("\n    );", start) > start, name);
  }
  // Mutators declare themselves as local writes, readers as read-only.
  for (const name of ["list_categories", "list_rules", "preview_rule"]) {
    const config = source.slice(source.indexOf(`      "${name}",`), source.indexOf("      async (", source.indexOf(`      "${name}",`)));
    assert.match(config, /readOnlyHint: true/, name);
  }
  for (const name of ["create_category", "rename_category", "add_rule", "update_rule", "delete_rule", "categorize_transaction", "clear_transaction_category"]) {
    const config = source.slice(source.indexOf(`      "${name}",`), source.indexOf("      async (", source.indexOf(`      "${name}",`)));
    assert.match(config, /readOnlyHint: false/, name);
    assert.match(config, /openWorldHint: false/, name);
    assert.match(config, /dry_run/, name);
  }
});

// ---- categories ----

test("create_category normalizes, dedupes by normalized name and never renames silently", async (t) => {
  const { db } = await setup(t);
  const first = await call(db, "create_category", { name: "  Groceries  " });
  assert.equal(first.name, "Groceries");
  assert.equal(first.created, true);
  assert.equal(first.revision, 1);
  const again = await call(db, "create_category", { name: "ＧＲＯＣＥＲＩＥＳ" });
  assert.equal(again.category_id, first.category_id);
  assert.equal(again.created, false);
  assert.equal(again.name, "Groceries");
  const list = await call(db, "list_categories", {});
  assert.equal(list.count, 1);
  assert.equal(list.limit, 200);
});

test("create_category rejects control characters, bad length and IBAN-shaped names without echoing them", async (t) => {
  const { db } = await setup(t);
  assert.deepEqual(await cat.createCategory(db, { name: "a\u0007b" }), { error: "invalid_argument", field: "name", reason: "control_character" });
  assert.deepEqual(await cat.createCategory(db, { name: "   " }), { error: "invalid_argument", field: "name", reason: "length" });
  const iban = await cat.createCategory(db, { name: IBAN });
  assert.deepEqual(iban, { error: "text_looks_like_account_number" });
  assert.equal(JSON.stringify(iban).includes(IBAN), false);
});

test("category cap: the 201st category is refused, reading and renaming still work", async (t) => {
  const { env, db } = await setup(t);
  const ins = env.DB.sqlite.prepare("INSERT INTO categories (id, name, name_key) VALUES (?, ?, ?)");
  for (let i = 0; i < 200; i++) ins.run(uuid(i + 1), `C${i}`, `c${i}`);
  const out = await cat.createCategory(db, { name: "One too many" });
  assert.equal(out.error, "cap_reached");
  assert.equal(out.limit, 200);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM categories").get().n, 200);
  const renamed = await cat.renameCategory(db, { category_id: uuid(1), name: "Renamed", expected_revision: 1 });
  assert.equal(renamed.revision, 2);
});

test("rename_category: optimistic lock, collision, stable id so rules and overrides follow the new name", async (t) => {
  const { db } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await newCategory(db, "Rent");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });

  assert.equal((await call(db, "rename_category", { category_id: food, name: "Groceries", expected_revision: 9 })).error, "revision_conflict");
  assert.equal((await call(db, "rename_category", { category_id: food, name: "rent", expected_revision: 1 })).error, "name_collision");
  const dry = await call(db, "rename_category", { category_id: food, name: "Groceries", expected_revision: 1, dry_run: true });
  assert.equal(dry.dry_run, true);
  const ok = await call(db, "rename_category", { category_id: food, name: "Groceries", expected_revision: 1 });
  assert.deepEqual(ok, { category_id: food, name: "Groceries", revision: 2 });
  // A retry of the landed rename is a no-op, not a conflict.
  assert.equal((await call(db, "rename_category", { category_id: food, name: "Groceries", expected_revision: 1 })).unchanged, true);
  const row = byCounterparty(await transactions(db), "Example Grocery");
  assert.equal(row.category, "Groceries");
  assert.equal(row.category_id, food);
  assert.equal((await call(db, "rename_category", { category_id: uuid(999), name: "X", expected_revision: 1 })).error, "not_found");
});

// ---- rules ----

test("add_rule validates predicates server-side and never allows a global catch-all", async (t) => {
  const { db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const bad = async (rule) => (await cat.addRule(db, { rule_id: uuid(50), rule }));
  assert.equal((await bad({ category_id: food, scope: { type: "all_accounts" }, direction: "out" })).reason, "catch_all_not_allowed");
  assert.equal((await bad({ category_id: food, scope: { type: "all_accounts" }, direction: "out", currency: "SEK" })).reason, "catch_all_not_allowed");
  assert.equal((await bad(groceryRule(food, { amount: { min_cents: 1 } }))).reason, "required_with_amount");
  assert.equal((await bad(groceryRule(food, { amount: {}, currency: "SEK" }))).reason, "empty");
  assert.equal((await bad(groceryRule(food, { amount: { min_cents: 5, max_cents: 1 }, currency: "SEK" }))).reason, "min_above_max");
  assert.equal((await bad(groceryRule(food, { booking_day: { from: 20, to: 10 } }))).reason, "from_after_to");
  assert.equal((await bad(groceryRule(food, { counterparty: { mode: "contains", value: "ab" } }))).reason, "contains_needs_3_characters");
  assert.equal((await bad(groceryRule(food, { counterparty: { mode: "regex", value: ".*" } }))).error, "invalid_argument");
  assert.equal((await bad({ ...groceryRule(food), unknown_field: 1 })).error, "invalid_argument");
  assert.equal((await bad({ ...groceryRule(food), direction: undefined })).error, "invalid_argument"); // direction is required
  assert.equal((await bad(groceryRule(food, { counterparty: { mode: "exact", value: "a\u0000b" } }))).reason, "control_character");
  assert.deepEqual(await bad(groceryRule(food, { counterparty: { mode: "contains", value: IBAN } })), { error: "text_looks_like_account_number" });
  assert.equal((await bad(groceryRule(uuid(77)))).error, "not_found");
  assert.equal((await bad(groceryRule(food, { scope: { type: "account", account_ref: "c".repeat(32) } }))).error, "not_found");
  // An account-scoped rule may have no text or amount predicate.
  const scoped = await cat.addRule(db, { rule_id: uuid(51), rule: { category_id: food, scope: { type: "account", account_ref: ref }, direction: "in" } });
  assert.equal(scoped.created, true);
  assert.equal(scoped.rule.scope.account_ref, ref);
  assert.equal(scoped.rule.scope.iban, "•••• 7466");
});

test("add_rule is idempotent on the client UUID; different content is an idempotency_conflict", async (t) => {
  const { env, db } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const first = await call(db, "add_rule", { rule_id: uuid(1), rule: groceryRule(food) });
  assert.equal(first.created, true);
  assert.equal(first.rule.revision, 1);
  assert.equal(first.rule.priority, 100);
  assert.equal(first.rule.enabled, true);
  // Same content, differently spelled but identically normalized: unchanged.
  const retry = await call(db, "add_rule", { rule_id: uuid(1), rule: groceryRule(food, { counterparty: { mode: "contains", value: "  grocery " } }) });
  assert.equal(retry.unchanged, true);
  const conflict = await call(db, "add_rule", { rule_id: uuid(1), rule: groceryRule(food, { priority: 5 }) });
  assert.deepEqual(conflict, { error: "idempotency_conflict" });
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM categorization_rules").get().n, 1);
});

test("update_rule and delete_rule use optimistic locking; retries of a landed change are no-ops", async (t) => {
  const { db } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food, { priority: 300, booking_day: { from: 1, to: 31 } }) });

  const stale = await call(db, "update_rule", { rule_id: uuid(1), rule: groceryRule(food, { priority: 50 }), expected_revision: 7 });
  assert.equal(stale.error, "revision_conflict");
  assert.equal(stale.current_revision, 1);
  const updated = await call(db, "update_rule", { rule_id: uuid(1), rule: groceryRule(food, { priority: 50 }), expected_revision: 1 });
  assert.equal(updated.rule.revision, 2);
  assert.equal(updated.rule.priority, 50);
  assert.equal("booking_day" in updated.rule, false, "full replacement clears omitted predicates");
  const retried = await call(db, "update_rule", { rule_id: uuid(1), rule: groceryRule(food, { priority: 50 }), expected_revision: 1 });
  assert.equal(retried.unchanged, true);
  assert.equal((await call(db, "update_rule", { rule_id: uuid(9), rule: groceryRule(food), expected_revision: 1 })).error, "not_found");

  assert.equal((await call(db, "delete_rule", { rule_id: uuid(1), expected_revision: 1 })).error, "revision_conflict");
  assert.deepEqual(await call(db, "delete_rule", { rule_id: uuid(1), expected_revision: 2 }), { rule_id: uuid(1), deleted: true });
  assert.deepEqual(await call(db, "delete_rule", { rule_id: uuid(1), expected_revision: 2 }), { rule_id: uuid(1), deleted: false });
  assert.equal(byCounterparty(await transactions(db), "Example Grocery").category, null);
});

test("rule cap: the 501st rule is refused; disabled rules count", async (t) => {
  const { env, db } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const ins = env.DB.sqlite.prepare(
    "INSERT INTO categorization_rules (id, category_id, direction, counterparty_mode, counterparty_pattern, enabled) VALUES (?, ?, 'out', 'exact', ?, 0)"
  );
  for (let i = 0; i < 500; i++) ins.run(uuid(1000 + i), food, `p${i}`);
  const out = await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });
  assert.equal(out.error, "cap_reached");
  assert.equal(out.limit, 500);
});

test("list_rules: evaluation order, rank, account filter includes global rules, pagination", async (t) => {
  const { db, ref } = await seedBasic(t);
  const other = await seedAccount(db, "acc2", { iban: "SE7280000810340009783242", name: "Savings" });
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food, { priority: 10 }) });
  await cat.addRule(db, { rule_id: uuid(2), rule: groceryRule(food, { priority: 900, counterparty: { mode: "exact", value: "Example Grocery" } }) });
  await cat.addRule(db, { rule_id: uuid(3), rule: { category_id: food, scope: { type: "account", account_ref: other }, direction: "any" } });
  await cat.addRule(db, { rule_id: uuid(4), rule: groceryRule(food, { priority: 500, enabled: false }) });

  const all = await call(db, "list_rules", {});
  assert.deepEqual(all.rules.map((r) => r.rule_id), [uuid(2), uuid(4), uuid(3), uuid(1)]);
  assert.deepEqual(all.rules.map((r) => r.rank ?? null), [1, null, 2, 3]);
  const mine = await call(db, "list_rules", { account_ref: ref });
  assert.deepEqual(mine.rules.map((r) => r.rule_id), [uuid(2), uuid(4), uuid(1)]);
  const enabledOnly = await call(db, "list_rules", { enabled: true, limit: 2 });
  assert.deepEqual(enabledOnly.rules.map((r) => r.rule_id), [uuid(2), uuid(3)]);
  assert.equal(enabledOnly.next_after_id, uuid(3));
  const page2 = await call(db, "list_rules", { enabled: true, limit: 2, after_id: enabledOnly.next_after_id });
  assert.deepEqual(page2.rules.map((r) => r.rule_id), [uuid(1)]);
  assert.equal(page2.next_after_id, null);
  // Output never carries the full IBAN or registry internals.
  const text = JSON.stringify(all);
  assert.equal(text.includes("SE7280000810340009783242"), false);
  assert.equal(text.includes("identification_hash"), false);
});

test("preview_rule reports matches, winners, overrides kept and outranking rules; writes nothing", async (t) => {
  const { env, db, ref } = await seedBasic(t);
  await db.insertTransactionsIgnore([
    tx("acc1", { booking_date: "2030-01-10", counterparty: "Example Grocery Two", dedup_key: "er:g2" }),
    tx("acc1", { booking_date: "2030-01-11", counterparty: "Example Grocery Three", dedup_key: "er:g3" }),
  ]);
  const food = await newCategory(db, "Food");
  const special = await newCategory(db, "Special");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(special, { priority: 900, counterparty: { mode: "exact", value: "Example Grocery Two" } }) });
  const g3 = byCounterparty(await transactions(db), "Example Grocery Three");
  await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: g3.transaction_key,
    expected: { booking_date: "2030-01-11", amount_cents: -12345, currency: "SEK" }, category_id: special, expected_revision: 0 });

  const before = snapshot(env);
  const out = await call(db, "preview_rule", { rule: groceryRule(food) });
  assert.deepEqual(snapshot(env), before);
  assert.equal(out.scanned, 5);
  assert.equal(out.truncated, false);
  assert.equal(out.matched, 3);
  assert.equal(out.would_win, 1);
  assert.equal(out.kept_by_manual_override, 1);
  assert.deepEqual(out.beaten_by_rules, [{ rule_id: uuid(1), rows: 1 }]);
  assert.equal(out.category_changes, 1);
  assert.equal(out.sample.length, 3);

  const truncated = await call(db, "preview_rule", { rule: groceryRule(food), limit: 2 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.scanned, 2);
  assert.match(truncated.note, /not full-history totals/);
});

// ---- manual overrides ----

test("categorize_transaction: create, manual beats rules, explicit null blocks rules, clear resumes rules", async (t) => {
  const { db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const other = await newCategory(db, "Other");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food, { priority: 1000 }) });
  const row = byCounterparty(await transactions(db), "Example Grocery");
  assert.equal(row.account_ref, ref);
  assert.match(row.transaction_key, /^[0-9a-f]{64}$/);
  assert.equal(row.transaction_key, await transactionKey("er:g1"));
  assert.equal(row.category_source, "rule");
  assert.equal(row.category_rule_id, uuid(1));
  assert.equal(row.category_override_revision, null);

  const expected = { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" };
  const base = { account_ref: ref, transaction_key: row.transaction_key, expected };

  const dry = await call(db, "categorize_transaction", { ...base, category_id: other, expected_revision: 0, dry_run: true });
  assert.equal(dry.would, "create");
  assert.equal(byCounterparty(await transactions(db), "Example Grocery").category_source, "rule");

  const created = await call(db, "categorize_transaction", { ...base, category_id: other, expected_revision: 0 });
  assert.deepEqual(created, { account_ref: ref, transaction_key: row.transaction_key, category: "Other", category_id: other, category_source: "manual", revision: 1 });
  let now = byCounterparty(await transactions(db), "Example Grocery");
  assert.equal(now.category, "Other");
  assert.equal(now.category_source, "manual");
  assert.equal(now.category_rule_id, null);
  assert.equal(now.category_override_revision, 1);

  // Retrying the create is idempotent; a create over an existing different override conflicts.
  assert.equal((await call(db, "categorize_transaction", { ...base, category_id: other, expected_revision: 0 })).unchanged, true);
  assert.equal((await call(db, "categorize_transaction", { ...base, category_id: food, expected_revision: 0 })).error, "revision_conflict");

  const nulled = await call(db, "categorize_transaction", { ...base, category_id: null, expected_revision: 1 });
  assert.equal(nulled.revision, 2);
  now = byCounterparty(await transactions(db), "Example Grocery");
  assert.equal(now.category, null);
  assert.equal(now.category_source, "manual");
  assert.equal(now.category_override_revision, 2);

  assert.equal((await call(db, "clear_transaction_category", { account_ref: ref, transaction_key: row.transaction_key, expected_revision: 1 })).error, "revision_conflict");
  const cleared = await call(db, "clear_transaction_category", { account_ref: ref, transaction_key: row.transaction_key, expected_revision: 2 });
  assert.equal(cleared.deleted, true);
  assert.deepEqual(cleared.after, { category: "Food", category_id: food, category_source: "rule", category_rule_id: uuid(1) });
  assert.equal(byCounterparty(await transactions(db), "Example Grocery").category_source, "rule");
  assert.equal((await call(db, "clear_transaction_category", { account_ref: ref, transaction_key: row.transaction_key, expected_revision: 2 })).deleted, false);
});

test("categorize_transaction verifies the expected facts and the derived key; never accepts an unverified key", async (t) => {
  const { db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const row = byCounterparty(await transactions(db), "Example Grocery");
  const good = { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" };
  const attempt = (overrides) => cat.categorizeTransaction(db, {
    account_ref: ref, transaction_key: row.transaction_key, expected: good, category_id: food, expected_revision: 0, ...overrides,
  });
  assert.equal((await attempt({ expected: { ...good, amount_cents: 12345 } })).error, "not_cached"); // sign matters
  assert.equal((await attempt({ expected: { ...good, booking_date: "2030-01-21" } })).error, "not_cached");
  assert.equal((await attempt({ expected: { ...good, currency: "EUR" } })).error, "not_cached");
  assert.equal((await attempt({ transaction_key: "0".repeat(64) })).error, "not_cached");
  assert.equal((await attempt({ account_ref: "d".repeat(32) })).error, "not_found");
  assert.equal((await attempt({ category_id: uuid(404) })).error, "not_found");
  assert.equal((await attempt({ expected_revision: 3 })).error, "revision_conflict");
  assert.equal((await attempt({})).revision, 1);
});

test("a stored override whose guards no longer match its row fails closed in reads and refuses edits", async (t) => {
  const { env, db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });
  const row = byCounterparty(await transactions(db), "Example Grocery");
  await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: row.transaction_key,
    expected: { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" }, category_id: food, expected_revision: 0 });
  // Simulate a key collision: the stored guard now disagrees with the cached row.
  env.DB.sqlite.prepare("UPDATE transaction_category_overrides SET amount_cents = 1").run();
  const now = byCounterparty(await transactions(db), "Example Grocery");
  assert.equal(now.category, null);
  assert.equal(now.category_source, "uncategorized");
  assert.equal(now.category_rule_id, null, "no fall-through to the matching rule");
  assert.equal(now.category_warning, "override_identity_conflict");
  const edit = await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: row.transaction_key,
    expected: { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" }, category_id: null, expected_revision: 1 });
  assert.equal(edit.error, "identity_conflict");
});

test("override cap: a new override at 10000 is refused while edits and clears still work", async (t) => {
  const { env, db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const row = byCounterparty(await transactions(db), "Example Grocery");
  const rent = byCounterparty(await transactions(db), "Example Landlord");
  await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: rent.transaction_key,
    expected: { booking_date: "2030-01-25", amount_cents: -850000, currency: "SEK" }, category_id: food, expected_revision: 0 });
  const ins = env.DB.sqlite.prepare(
    "INSERT INTO transaction_category_overrides (account_identity_id, transaction_key, category_id, booking_date, amount_cents, currency, credit_debit) VALUES (?, ?, NULL, '2000-01-01', 1, 'SEK', 'DBIT')"
  );
  env.DB.sqlite.exec("BEGIN");
  for (let i = 0; i < 9999; i++) ins.run(ref, i.toString(16).padStart(64, "0"));
  env.DB.sqlite.exec("COMMIT");
  const refused = await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: row.transaction_key,
    expected: { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" }, category_id: food, expected_revision: 0 });
  assert.equal(refused.error, "cap_reached");
  assert.equal(refused.limit, 10000);
  const edited = await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: rent.transaction_key,
    expected: { booking_date: "2030-01-25", amount_cents: -850000, currency: "SEK" }, category_id: null, expected_revision: 1 });
  assert.equal(edited.revision, 2);
  assert.equal((await cat.clearTransactionCategory(db, { account_ref: ref, transaction_key: rent.transaction_key, expected_revision: 2 })).deleted, true);
});

test("an override survives re-authorization and fold of a duplicate row into the new generation", async (t) => {
  const { db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: { category_id: food, scope: { type: "account", account_ref: ref }, direction: "in" } });
  const rent = byCounterparty(await transactions(db), "Example Landlord");
  await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: rent.transaction_key,
    expected: { booking_date: "2030-01-25", amount_cents: -850000, currency: "SEK" }, category_id: food, expected_revision: 0 });

  // New uid for the same account (re-authorization); the same transaction arrives again under it.
  const ref2 = await seedAccount(db, "acc1-new");
  assert.equal(ref2, ref);
  await db.insertTransactionsIgnore([tx("acc1-new", { booking_date: "2030-01-25", counterparty: "Example Landlord", amount_cents: 850000, dedup_key: "er:rent" })]);
  const folded = await db.foldAccountGeneration("acc1", "acc1-new");
  assert.equal(folded.collapsed, 1);

  const out = await transactions(db);
  const after = byCounterparty(out, "Example Landlord");
  assert.equal(after.transaction_key, rent.transaction_key);
  assert.equal(after.category_source, "manual");
  assert.equal(after.category, "Food");
  assert.equal(byCounterparty(out, "Employer AB").category_rule_id, uuid(1), "account-scoped rule follows the identity");
});

test("pending rows get provisional rule categories and no writable key", async (t) => {
  const { db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });
  await db.replacePending("acc1", [{ ...tx("acc1"), booking_date: "2030-02-01", counterparty: "Example Grocery" }]);
  const out = await transactions(db);
  assert.deepEqual(out.pending[0], {
    account: "Everyday", booking_date: "2030-02-01", amount: -123.45, currency: "SEK", counterparty: "Example Grocery",
    description: "Card purchase", status: "PENDING", account_ref: ref, category: "Food", category_id: food,
    category_source: "rule", category_rule_id: uuid(1), category_provisional: true,
  });
});

// ---- guards shared with labels ----

test("dry runs write nothing at all, including the rate-limit table", async (t) => {
  const { env, db, ref } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });
  const row = byCounterparty(await transactions(db), "Example Grocery");
  await cat.categorizeTransaction(db, { account_ref: ref, transaction_key: row.transaction_key,
    expected: { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" }, category_id: food, expected_revision: 0 });
  const rent = byCounterparty(await transactions(db), "Example Landlord");

  const before = snapshot(env);
  const results = [
    await call(db, "create_category", { name: "Brand new", dry_run: true }),
    await call(db, "rename_category", { category_id: food, name: "Groceries", expected_revision: 1, dry_run: true }),
    await call(db, "add_rule", { rule_id: uuid(2), rule: groceryRule(food, { priority: 5 }), dry_run: true }),
    await call(db, "update_rule", { rule_id: uuid(1), rule: groceryRule(food, { priority: 5 }), expected_revision: 1, dry_run: true }),
    await call(db, "delete_rule", { rule_id: uuid(1), expected_revision: 1, dry_run: true }),
    await call(db, "categorize_transaction", { account_ref: ref, transaction_key: rent.transaction_key,
      expected: { booking_date: "2030-01-25", amount_cents: -850000, currency: "SEK" }, category_id: food, expected_revision: 0, dry_run: true }),
    await call(db, "categorize_transaction", { account_ref: ref, transaction_key: row.transaction_key,
      expected: { booking_date: "2030-01-20", amount_cents: -12345, currency: "SEK" }, category_id: null, expected_revision: 1, dry_run: true }),
    await call(db, "clear_transaction_category", { account_ref: ref, transaction_key: row.transaction_key, expected_revision: 1, dry_run: true }),
  ];
  for (const r of results) assert.equal(r.dry_run, true, JSON.stringify(r));
  assert.equal(results[2].preview.matched, 1);
  assert.deepEqual(results[7].after, { category: "Food", category_id: food, category_source: "rule", category_rule_id: uuid(1) });
  assert.deepEqual(snapshot(env), before);
});

test("the 31st mutation in a minute is rate limited, shared with set_account_label; dry runs are not counted", async (t) => {
  const { db } = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await cat.createCategory(db, { name: `Dry ${i}`, dry_run: true })).dry_run, true);
  for (let i = 0; i < 29; i++) assert.equal((await cat.createCategory(db, { name: `Cat ${i}` })).created, true);
  // One slot left: spent by the shared label budget key.
  assert.equal(await db.rateLimitOk("mcp_mutation", 30, 60_000), true);
  assert.deepEqual(await cat.createCategory(db, { name: "Thirty-one" }), { error: "rate_limited" });
});

test("arguments over 16 KiB are refused before touching storage", async (t) => {
  const { env, db } = await seedBasic(t);
  const before = snapshot(env);
  const big = "x".repeat(17_000);
  assert.deepEqual(await cat.createCategory(db, { name: big }), { error: "invalid_argument", field: "args", reason: "too_large" });
  assert.deepEqual(await cat.previewRule(db, { rule: { padding: big } }), { error: "invalid_argument", field: "args", reason: "too_large" });
  assert.deepEqual(snapshot(env), before);
});

// ---- read surfaces ----

test("get_transactions and export_statements agree on categories; export keeps balances, order and masking", async (t) => {
  const { env, db, ref } = await seedBasic(t);
  await db.upsertBalances([{ account_uid: "acc1", balance_type: "ITBD", amount_cents: 1000000, currency: "SEK", fetched_at: "2030-02-01" }]);
  const food = await newCategory(db, "Food");
  const rent = await newCategory(db, "Rent");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });
  await cat.addRule(db, { rule_id: uuid(2), rule: { category_id: rent, scope: { type: "account", account_ref: ref }, direction: "out",
    amount: { min_cents: 850000, max_cents: 850000 }, currency: "SEK", priority: 200 } });

  const live = await transactions(db);
  const data = await buildStatementExport(env, { since: "2030-01-01" });
  assert.equal(data.accounts.length, 1);
  const acct = data.accounts[0];
  assert.equal(acct.account_ref, ref);
  assert.equal(acct.iban, "•••• 7466");
  assert.deepEqual(acct.transactions.map((r) => r.booking_date), ["2030-01-26", "2030-01-25", "2030-01-20"]);
  assert.deepEqual(acct.transactions.map((r) => r.balance_cents), [1000000, -2000000, -1150000]);
  assert.deepEqual(acct.transactions.map((r) => r.amount_cents), [3000000, -850000, -12345]);
  for (const e of acct.transactions) {
    const g = live.booked.find((b) => b.transaction_key === e.transaction_key);
    for (const k of ["category", "category_id", "category_source", "category_rule_id", "category_override_revision"]) {
      assert.deepEqual(e[k], g[k], k);
    }
  }
  assert.equal(acct.transactions[1].category, "Rent");
  assert.equal(acct.transactions[2].category, "Food");
  assert.equal(acct.transactions[0].category_source, "uncategorized");

  const text = JSON.stringify(data) + JSON.stringify(live);
  for (const secret of [IBAN, "er:g1", "ref-", "dedup_key", "entry_reference", "session_id", "identification_hash", "\"raw\""]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("spending_summary group_by category sums per category and currency", async (t) => {
  const { db } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  await cat.addRule(db, { rule_id: uuid(1), rule: groceryRule(food) });
  await db.insertTransactionsIgnore([tx("acc1", { counterparty: "Example Grocery Two", amount_cents: 655, dedup_key: "er:g2" })]);
  const out = parse(await handler("spending_summary", deps).call(self(db), { group_by: "category", limit: 24 }));
  assert.deepEqual(out.groups, [
    { category: "(uncategorized)", currency: "SEK", out: 8500, in: 30000, net: 21500, count: 2 },
    { category: "Food", currency: "SEK", out: 130, in: 0, net: -130, count: 2 },
  ]);
  assert.deepEqual(out.totals, [{ currency: "SEK", out: 8630, in: 30000, net: 21370, count: 4 }]);
  // Existing groupings are untouched.
  const byMonth = parse(await handler("spending_summary", deps).call(self(db), { group_by: "month", limit: 24 }));
  assert.equal(byMonth.groups[0].month, "2030-01");
  // No account match never broadens to all accounts.
  const none = await cat.summarizeByCategory(db, { accountUids: [], limit: 10 });
  assert.deepEqual(none, { rows: [] });
});

test("every handler slice returns the same payload as the direct service call", async (t) => {
  const { db } = await setup(t);
  const viaHandler = await call(db, "create_category", { name: "Via handler" });
  assert.equal(viaHandler.created, true);
  const list = await call(db, "list_categories", {});
  assert.deepEqual(list, await cat.listCategories(db));
});

test("bounded cost: 500 rows and 500 rules categorize with a fixed, small number of D1 queries", async (t) => {
  const { env, db } = await seedBasic(t);
  const food = await newCategory(db, "Food");
  const ins = env.DB.sqlite.prepare(
    "INSERT INTO categorization_rules (id, category_id, direction, counterparty_mode, counterparty_pattern, priority) VALUES (?, ?, 'any', 'contains', ?, ?)"
  );
  env.DB.sqlite.exec("BEGIN");
  for (let i = 0; i < 500; i++) ins.run(uuid(5000 + i), food, `no-such-payee-${i}`, i % 1000);
  env.DB.sqlite.exec("COMMIT");
  const rows = [];
  for (let i = 0; i < 497; i++) rows.push(tx("acc1", { counterparty: `Payee ${"x".repeat(400)} ${i}`, dedup_key: `er:bulk-${i}` }));
  await db.insertTransactionsIgnore(rows);

  let queries = 0;
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => { queries++; return prepare(sql); };
  const started = Date.now();
  const out = await transactions(db, { limit: 500 });
  const elapsed = Date.now() - started;
  env.DB.prepare = prepare;
  assert.equal(out.booked.length, 500);
  assert.ok(out.booked.every((r) => r.category_source === "uncategorized"));
  // accounts, booked, pending, rules, identities (1 chunk), overrides (13 chunks of 40), warnings
  assert.ok(queries <= 20, `queries: ${queries}`);
  assert.ok(elapsed < 5000, `elapsed ${elapsed}ms`);
});
