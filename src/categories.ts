/**
 * Local categories, rules and manual overrides (Step 2). Everything here reads
 * and writes this Worker's own D1 cache only: no Enable Banking client, no
 * fetch, no refresh or detail budget. Categories are evaluated at read time by
 * the pure evaluator in categorization.ts, so a rule edit applies to history
 * and future rows alike without rewriting any transaction.
 */
import { z } from "zod";
import {
  compareRules,
  compileRule,
  evaluate,
  matchKey,
  RuleSet,
  ruleMatches,
  type CategoryResult,
  type OverrideRow,
  type RuleRow,
} from "./categorization";
import type { Db } from "./db";
import { transactionKey } from "./identity";
import { compactJson } from "./mcp-output";
import { checkMutationBudget, enforceArgBudget, type ErrorCode } from "./mutation-guard";
import { ACCOUNT_REF_RE, containsIbanLike, maskIban, normalizeText, TRANSACTION_KEY_RE } from "./util";

// ---- limits (application policy, not bank limits) ----

export const MAX_CATEGORIES = 200;
export const MAX_RULES = 500;
export const MAX_OVERRIDES = 10_000;
/** Rows loaded for a group_by: "category" summary; beyond this the caller must narrow the range. */
export const MAX_CATEGORY_SUMMARY_ROWS = 5_000;
/** Pairs per bulk override lookup: 2 bound parameters each, well under D1's 100-parameter limit. */
const OVERRIDE_PAIRS_PER_QUERY = 40;
/** Cached rows read when resolving one manual override target. */
const MAX_OVERRIDE_CANDIDATES = 500;

// ---- input schemas (shared by src/mcp.ts registration and direct callers) ----

const Currency = z.string().regex(/^[A-Z]{3}$/);
const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const CategoryIdSchema = z.uuid();
export const AccountRefSchema = z.string().regex(ACCOUNT_REF_RE);
export const TransactionKeySchema = z.string().regex(TRANSACTION_KEY_RE);
export const RevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const textMatch = (max: number) =>
  z.object({ mode: z.enum(["exact", "contains"]), value: z.string().min(1).max(max) }).strict();

export const RuleSchema = z
  .object({
    category_id: CategoryIdSchema,
    scope: z.discriminatedUnion("type", [
      z.object({ type: z.literal("all_accounts") }).strict(),
      z.object({ type: z.literal("account"), account_ref: AccountRefSchema }).strict(),
    ]),
    direction: z.enum(["in", "out", "any"]),
    counterparty: textMatch(160).optional(),
    remittance: textMatch(256).optional(),
    amount: z.object({ min_cents: Cents.optional(), max_cents: Cents.optional() }).strict().optional(),
    currency: Currency.optional(),
    booking_day: z.object({ from: z.number().int().min(1).max(31), to: z.number().int().min(1).max(31) }).strict().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type RuleInput = z.infer<typeof RuleSchema>;

export const ExpectedTransactionSchema = z
  .object({
    booking_date: z.iso.date(),
    amount_cents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    currency: Currency,
  })
  .strict();

// ---- result helpers ----

type ToolError = { error: ErrorCode; field?: string; reason?: string };
const err = (error: ErrorCode, field?: string, reason?: string): ToolError =>
  field ? { error, field, ...(reason ? { reason } : {}) } : { error };
const tooLarge = (): ToolError => err("invalid_argument", "args", "too_large");
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// ---- stored shapes ----

interface CategoryRow {
  id: string;
  name: string;
  name_key: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

type StoredRuleRow = Omit<RuleRow, "category_name"> & { updated_at: string };

/** Rule fields in storage form, after server-side validation and normalization. */
interface NormalizedRule {
  category_id: string;
  account_identity_id: string | null;
  priority: number;
  enabled: number;
  direction: "in" | "out" | "any";
  counterparty_mode: "exact" | "contains" | null;
  counterparty_pattern: string | null;
  remittance_mode: "exact" | "contains" | null;
  remittance_pattern: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  currency: string | null;
  booking_day_from: number | null;
  booking_day_to: number | null;
}

const RULE_CONTENT_FIELDS: Array<keyof NormalizedRule> = [
  "category_id", "account_identity_id", "priority", "enabled", "direction",
  "counterparty_mode", "counterparty_pattern", "remittance_mode", "remittance_pattern",
  "amount_min_cents", "amount_max_cents", "currency", "booking_day_from", "booking_day_to",
];

function sameRuleContent(a: NormalizedRule, b: { [K in keyof NormalizedRule]: unknown }): boolean {
  return RULE_CONTENT_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

// ---- validation ----

/** Display-form category name: normalized, 1..80 chars, no control characters, not IBAN-shaped. */
function cleanCategoryName(name: string): { ok: true; name: string; key: string } | { ok: false; error: ToolError } {
  if (CONTROL_RE.test(name)) return { ok: false, error: err("invalid_argument", "name", "control_character") };
  const clean = normalizeText(name);
  if (clean.length < 1 || clean.length > 80) return { ok: false, error: err("invalid_argument", "name", "length") };
  if (containsIbanLike(clean)) return { ok: false, error: err("text_looks_like_account_number") };
  return { ok: true, name: clean, key: matchKey(clean) };
}

function cleanPattern(
  field: "counterparty" | "remittance",
  m: { mode: "exact" | "contains"; value: string },
  max: number
): { ok: true; mode: "exact" | "contains"; pattern: string } | { ok: false; error: ToolError } {
  if (CONTROL_RE.test(m.value)) return { ok: false, error: err("invalid_argument", `rule.${field}.value`, "control_character") };
  const pattern = normalizeText(m.value);
  const key = matchKey(pattern);
  // Both the stored text and its lowercased match key must fit: lowercasing can
  // lengthen a string (U+0130 becomes two code units).
  if (key.length < 1 || pattern.length > max || key.length > max) {
    return { ok: false, error: err("invalid_argument", `rule.${field}.value`, "length") };
  }
  if (m.mode === "contains" && key.length < 3) {
    return { ok: false, error: err("invalid_argument", `rule.${field}.value`, "contains_needs_3_characters") };
  }
  if (containsIbanLike(pattern)) return { ok: false, error: err("text_looks_like_account_number") };
  return { ok: true, mode: m.mode, pattern };
}

/**
 * Validate one rule beyond its Zod shape and resolve it to storage form.
 * Checks referenced category and account identity against this database.
 */
async function normalizeRule(db: Db, input: unknown): Promise<{ ok: true; rule: NormalizedRule; categoryName: string } | { ok: false; error: ToolError }> {
  const parsed = RuleSchema.safeParse(input);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    return { ok: false, error: err("invalid_argument", path ? `rule.${path}` : "rule", "invalid") };
  }
  const r = parsed.data;
  const cp = r.counterparty ? cleanPattern("counterparty", r.counterparty, 160) : null;
  if (cp && !cp.ok) return cp;
  const rem = r.remittance ? cleanPattern("remittance", r.remittance, 256) : null;
  if (rem && !rem.ok) return rem;
  const min = r.amount?.min_cents ?? null;
  const max = r.amount?.max_cents ?? null;
  if (r.amount && min === null && max === null) return { ok: false, error: err("invalid_argument", "rule.amount", "empty") };
  if (min !== null && max !== null && min > max) return { ok: false, error: err("invalid_argument", "rule.amount", "min_above_max") };
  if ((min !== null || max !== null) && !r.currency) {
    return { ok: false, error: err("invalid_argument", "rule.currency", "required_with_amount") };
  }
  if (r.booking_day && r.booking_day.from > r.booking_day.to) {
    return { ok: false, error: err("invalid_argument", "rule.booking_day", "from_after_to") };
  }
  const accountIdentityId = r.scope.type === "account" ? r.scope.account_ref : null;
  if (accountIdentityId === null && !cp && !rem && min === null && max === null) {
    // A global rule needs at least one text or amount predicate: no accidental catch-all.
    return { ok: false, error: err("invalid_argument", "rule", "catch_all_not_allowed") };
  }
  const category = await categoryById(db, r.category_id);
  if (!category) return { ok: false, error: err("not_found", "rule.category_id") };
  if (accountIdentityId !== null && !(await db.identityById(accountIdentityId))) {
    return { ok: false, error: err("not_found", "rule.scope.account_ref") };
  }
  const rule: NormalizedRule = {
      category_id: r.category_id,
      account_identity_id: accountIdentityId,
      priority: r.priority ?? 100,
      enabled: r.enabled === false ? 0 : 1,
      direction: r.direction,
      counterparty_mode: cp ? cp.mode : null,
      counterparty_pattern: cp ? cp.pattern : null,
      remittance_mode: rem ? rem.mode : null,
      remittance_pattern: rem ? rem.pattern : null,
      amount_min_cents: min,
      amount_max_cents: max,
      currency: r.currency ?? null,
      booking_day_from: r.booking_day?.from ?? null,
      booking_day_to: r.booking_day?.to ?? null,
  };
  // Single source of validation: the exact row about to be stored must compile
  // under the same function the read path uses, or it is refused here.
  const compiled = compileRule({ ...rule, id: "(validation)", category_name: category.name, revision: 1, created_at: "" });
  if (compiled === null) return { ok: false, error: err("invalid_argument", "rule", "invalid") };
  return { ok: true, categoryName: category.name, rule };
}

// ---- repository: categories ----

async function categoryById(db: Db, id: string): Promise<CategoryRow | null> {
  return db.database.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<CategoryRow>();
}

async function categoryByKey(db: Db, key: string): Promise<CategoryRow | null> {
  return db.database.prepare("SELECT * FROM categories WHERE name_key = ?").bind(key).first<CategoryRow>();
}

const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

// ---- repository: rules ----

async function storedRule(db: Db, id: string): Promise<StoredRuleRow | null> {
  return db.database.prepare("SELECT * FROM categorization_rules WHERE id = ?").bind(id).first<StoredRuleRow>();
}

/** Every rule (enabled or not) with its category name, in evaluation order. */
async function allRules(db: Db): Promise<RuleRow[]> {
  const r = await db.database
    .prepare(
      `SELECT r.*, c.name AS category_name FROM categorization_rules r JOIN categories c ON c.id = r.category_id
       ORDER BY r.priority DESC, r.created_at ASC, r.id ASC`
    )
    .all<RuleRow>();
  return r.results;
}

/** One immutable rule snapshot per request; enabled rules only. */
export async function loadRuleSet(db: Db): Promise<RuleSet> {
  const r = await db.database
    .prepare(
      `SELECT r.*, c.name AS category_name FROM categorization_rules r JOIN categories c ON c.id = r.category_id
       WHERE r.enabled = 1 ORDER BY r.priority DESC, r.created_at ASC, r.id ASC`
    )
    .all<RuleRow>();
  return new RuleSet(r.results);
}

// ---- repository: overrides ----

const OVERRIDE_SELECT = `SELECT o.account_identity_id, o.transaction_key, o.category_id, c.name AS category_name,
  o.booking_date, o.amount_cents, o.currency, o.credit_debit, o.revision
  FROM transaction_category_overrides o LEFT JOIN categories c ON c.id = o.category_id`;

const pairKey = (identity: string, key: string) => `${identity}:${key}`;

/** Bulk lookup in bounded chunks; never one query per transaction. */
async function overridesForPairs(db: Db, pairs: Array<[string, string]>): Promise<Map<string, OverrideRow>> {
  const out = new Map<string, OverrideRow>();
  if (pairs.length === 0) return out;
  // One cheap probe instead of up to 13 chunked lookups when nobody has categorized anything.
  const identities = [...new Set(pairs.map((p) => p[0]))];
  const withOverrides = new Set<string>();
  for (let i = 0; i < identities.length; i += 90) {
    const chunk = identities.slice(i, i + 90);
    const r = await db.database
      .prepare(`SELECT DISTINCT account_identity_id FROM transaction_category_overrides WHERE account_identity_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ account_identity_id: string }>();
    for (const row of r.results) withOverrides.add(row.account_identity_id);
  }
  pairs = pairs.filter((p) => withOverrides.has(p[0]));
  const unique = [...new Map(pairs.map((p) => [pairKey(p[0], p[1]), p])).values()];
  for (let i = 0; i < unique.length; i += OVERRIDE_PAIRS_PER_QUERY) {
    const chunk = unique.slice(i, i + OVERRIDE_PAIRS_PER_QUERY);
    const where = chunk.map(() => "(o.account_identity_id = ? AND o.transaction_key = ?)").join(" OR ");
    const r = await db.database.prepare(`${OVERRIDE_SELECT} WHERE ${where}`).bind(...chunk.flat()).all<OverrideRow>();
    for (const row of r.results) out.set(pairKey(row.account_identity_id, row.transaction_key), row);
  }
  return out;
}

async function overridesForIdentity(db: Db, identityId: string): Promise<Map<string, OverrideRow>> {
  const r = await db.database.prepare(`${OVERRIDE_SELECT} WHERE o.account_identity_id = ?`).bind(identityId).all<OverrideRow>();
  return new Map(r.results.map((row) => [row.transaction_key, row]));
}

async function overrideFor(db: Db, identityId: string, key: string): Promise<OverrideRow | null> {
  return db.database
    .prepare(`${OVERRIDE_SELECT} WHERE o.account_identity_id = ? AND o.transaction_key = ?`)
    .bind(identityId, key)
    .first<OverrideRow>();
}

// ---- read-time annotation ----

/** Only the columns categorization needs; never raw bank payloads. */
const CATEGORY_ROW_COLUMNS = "id, account_uid, booking_date, amount_cents, currency, credit_debit, counterparty, remittance_info, dedup_key";

/** Booked rows for category work (summary, preview), newest first, same filters as queryTransactions. */
async function bookedRowsForCategories(
  db: Db,
  opts: { accountUids?: string[] | null; dateFrom?: string; dateTo?: string; limit: number }
): Promise<BookedRow[]> {
  if (opts.accountUids?.length === 0) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.accountUids) {
    where.push(`account_uid IN (${opts.accountUids.map(() => "?").join(",")})`);
    params.push(...opts.accountUids);
  }
  if (opts.dateFrom) { where.push("booking_date >= ?"); params.push(opts.dateFrom); }
  if (opts.dateTo) { where.push("booking_date <= ?"); params.push(opts.dateTo); }
  params.push(opts.limit);
  const r = await db.database
    .prepare(`SELECT ${CATEGORY_ROW_COLUMNS} FROM transactions ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY booking_date DESC, id DESC LIMIT ?`)
    .bind(...params)
    .all<BookedRow>();
  return r.results;
}

interface CachedRow {
  account_uid: string;
  booking_date: string;
  amount_cents: number;
  currency: string;
  credit_debit: string;
  counterparty: string | null;
  remittance_info: string | null;
}
interface BookedRow extends CachedRow {
  dedup_key: string;
}

/** Category fields added to a booked row: stable selectors first, then provenance. */
export type BookedCategoryFields = { account_ref: string | null; transaction_key: string | null } & CategoryResult;
/** Pending rows have no durable key and no override: rules only, marked provisional. */
export type PendingCategoryFields = {
  account_ref: string | null;
  category: string | null;
  category_id: string | null;
  category_source: CategoryResult["category_source"];
  category_rule_id: string | null;
  category_provisional: true;
  category_uncertain?: true;
  category_warning?: CategoryResult["category_warning"];
};

function pendingFields(ref: string | null, r: CategoryResult): PendingCategoryFields {
  return {
    account_ref: ref,
    category: r.category,
    category_id: r.category_id,
    category_source: r.category_source,
    category_rule_id: r.category_rule_id,
    category_provisional: true,
    ...(r.category_uncertain ? { category_uncertain: true as const } : {}),
    ...(r.category_warning ? { category_warning: r.category_warning } : {}),
  };
}

/**
 * Category fields for one get_transactions row. compact keeps only what a
 * reader needs (category, category_source and any flag); the selectors and
 * provenance ids used for writes stay in the full shape.
 */
export function categoryFields(f: BookedCategoryFields | PendingCategoryFields, compact?: boolean): Record<string, unknown> {
  if (!compact) return { ...f };
  const out: Record<string, unknown> = { category: f.category, category_source: f.category_source };
  if (f.category_uncertain) out.category_uncertain = true;
  if (f.category_warning) out.category_warning = f.category_warning;
  if ("category_provisional" in f) out.category_provisional = true;
  return out;
}

/**
 * Categorize cached rows for get_transactions (and spending_summary): one rule
 * snapshot, one identity lookup, chunked override lookups. Returns fields in
 * the same order as the input arrays.
 */
export async function annotateTransactions(
  db: Db,
  booked: BookedRow[],
  pending: CachedRow[] = [],
  rules?: RuleSet
): Promise<{ booked: BookedCategoryFields[]; pending: PendingCategoryFields[] }> {
  if (booked.length === 0 && pending.length === 0) return { booked: [], pending: [] };
  const ruleSet = rules ?? (await loadRuleSet(db));
  const uids = [...new Set([...booked, ...pending].map((r) => r.account_uid))];
  const identities = await db.accountIdentitiesForUids(uids);
  const identityOf = (uid: string) => identities.get(uid) ?? null;

  const keys = await Promise.all(
    booked.map((r) => (identityOf(r.account_uid) !== null ? transactionKey(r.dedup_key) : Promise.resolve(null)))
  );
  const pairs: Array<[string, string]> = [];
  booked.forEach((r, i) => {
    const id = identityOf(r.account_uid);
    const key = keys[i];
    if (id !== null && key !== null) pairs.push([id, key]);
  });
  const overrides = await overridesForPairs(db, pairs);

  const bookedOut = booked.map((r, i) => {
    const ref = identityOf(r.account_uid);
    const key = keys[i];
    const override = ref !== null && key !== null ? overrides.get(pairKey(ref, key)) ?? null : null;
    return { account_ref: ref, transaction_key: key, ...evaluate({ ...r, account_identity_id: ref }, ruleSet, override) };
  });
  const pendingOut = pending.map((r) => {
    const ref = identityOf(r.account_uid);
    return pendingFields(ref, evaluate({ ...r, account_identity_id: ref }, ruleSet, null));
  });
  return { booked: bookedOut, pending: pendingOut };
}

/** Per-account categorizer for export_statements: overrides loaded once per identity. */
export async function statementCategorizer(db: Db): Promise<(identityId: string | null) => Promise<(row: BookedRow) => Promise<BookedCategoryFields>>> {
  const ruleSet = await loadRuleSet(db);
  return async (identityId) => {
    const overrides = identityId !== null ? await overridesForIdentity(db, identityId) : new Map<string, OverrideRow>();
    return async (row) => {
      const key = identityId !== null ? await transactionKey(row.dedup_key) : null;
      const override = key !== null ? overrides.get(key) ?? null : null;
      return { account_ref: identityId, transaction_key: key, ...evaluate({ ...row, account_identity_id: identityId }, ruleSet, override) };
    };
  };
}

export interface CategorySummaryRow {
  /** null only for the truly-uncategorized group; see `uncategorized`. */
  key: string | null;
  category_id: string | null;
  /** True only for the truly-uncategorized group, never for a user category named "(uncategorized)". */
  uncategorized: boolean;
  currency: string;
  out_cents: number;
  in_cents: number;
  count: number;
}

/**
 * spending_summary group_by "category": categories are decided at read time,
 * so booked rows are loaded (bounded) and summed in the Worker, per currency.
 */
export async function summarizeByCategory(
  db: Db,
  opts: { accountUids?: string[] | null; dateFrom?: string; dateTo?: string; limit: number }
): Promise<{ rows: CategorySummaryRow[] } | ToolError & { reason: string; limit: number; hint: string }> {
  if (opts.accountUids?.length === 0) return { rows: [] };
  const rows = await bookedRowsForCategories(db, { ...opts, limit: MAX_CATEGORY_SUMMARY_ROWS + 1 });
  if (rows.length > MAX_CATEGORY_SUMMARY_ROWS) {
    // Same unbounded default window as the other groupings; only the row cap differs.
    return {
      error: "too_many_candidates",
      reason: "too_many_rows",
      limit: MAX_CATEGORY_SUMMARY_ROWS,
      hint: `group_by category sums at most ${MAX_CATEGORY_SUMMARY_ROWS} booked rows per call. Pass date_from and date_to (for example one month) or an account filter.`,
    };
  }
  const { booked } = await annotateTransactions(db, rows);
  const groups = new Map<string, CategorySummaryRow>();
  rows.forEach((r, i) => {
    // Grouped by category_id, never by name: uncategorized rows can never merge
    // with a user category that happens to be called "(uncategorized)". The
    // truly-uncategorized group's key is null (not the string "(uncategorized)")
    // so it can never collide with a user category of that same name; callers
    // must key off `uncategorized`, not the label text.
    const categoryId = booked[i].category_id;
    const uncategorized = categoryId === null;
    const key = uncategorized ? null : booked[i].category ?? "(uncategorized)";
    const id = `${categoryId ?? ""}\u0000${r.currency}`;
    const g = groups.get(id) ?? { key, category_id: categoryId, uncategorized, currency: r.currency, out_cents: 0, in_cents: 0, count: 0 };
    if (r.credit_debit === "DBIT") g.out_cents += Math.abs(r.amount_cents);
    else g.in_cents += Math.abs(r.amount_cents);
    g.count++;
    groups.set(id, g);
  });
  const sorted = [...groups.values()].sort(
    (a, b) => b.out_cents - a.out_cents || b.in_cents - a.in_cents || ((a.key ?? "") < (b.key ?? "") ? -1 : (a.key ?? "") > (b.key ?? "") ? 1 : 0) ||
      ((a.category_id ?? "") < (b.category_id ?? "") ? -1 : (a.category_id ?? "") > (b.category_id ?? "") ? 1 : 0) || (a.currency < b.currency ? -1 : 1)
  );
  return { rows: sorted.slice(0, opts.limit) };
}

// ---- output mapping ----

async function accountDisplay(db: Db): Promise<Map<string, { account: string | null; iban: string | null }>> {
  const out = new Map<string, { account: string | null; iban: string | null }>();
  for (const a of await db.allAccountsWithBank()) {
    if (!a.account_identity_id || out.has(a.account_identity_id)) continue;
    out.set(a.account_identity_id, { account: a.label ?? a.name, iban: maskIban(a.iban) });
  }
  return out;
}

function ruleOut(
  r: Omit<RuleRow, "category_name">,
  categoryName: string | null,
  accounts?: Map<string, { account: string | null; iban: string | null }>
) {
  const scopeAccount = r.account_identity_id ? accounts?.get(r.account_identity_id) : undefined;
  return compactJson({
    rule_id: r.id,
    revision: r.revision,
    category_id: r.category_id,
    category: categoryName,
    scope: r.account_identity_id
      ? { type: "account", account_ref: r.account_identity_id, account: scopeAccount?.account ?? null, iban: scopeAccount?.iban ?? null }
      : { type: "all_accounts" },
    direction: r.direction,
    counterparty: r.counterparty_mode ? { mode: r.counterparty_mode, value: r.counterparty_pattern } : null,
    remittance: r.remittance_mode ? { mode: r.remittance_mode, value: r.remittance_pattern } : null,
    amount: r.amount_min_cents !== null || r.amount_max_cents !== null
      ? { min_cents: r.amount_min_cents, max_cents: r.amount_max_cents } : null,
    currency: r.currency,
    booking_day: r.booking_day_from !== null ? { from: r.booking_day_from, to: r.booking_day_to } : null,
    priority: r.priority,
    enabled: r.enabled === 1,
    created_at: r.created_at,
  });
}

function signedCents(row: { amount_cents: number; credit_debit: string }): number {
  return row.credit_debit === "DBIT" ? -Math.abs(row.amount_cents) : Math.abs(row.amount_cents);
}

// ---- tools: categories ----

export async function createCategory(db: Db, args: { name: string; dry_run?: boolean }) {
  if (!enforceArgBudget(args)) return tooLarge();
  const clean = cleanCategoryName(args.name);
  if (!clean.ok) return clean.error;
  const existing = await categoryByKey(db, clean.key);
  if (existing) {
    // Same normalized name: the existing category is the answer; its display spelling is not changed.
    return { category_id: existing.id, name: existing.name, revision: existing.revision, created: false };
  }
  if (args.dry_run) return { dry_run: true, would: "create", name: clean.name };
  if (!(await checkMutationBudget(db))) return err("rate_limited");
  const id = crypto.randomUUID();
  try {
    const row = await db.database
      .prepare(
        `INSERT INTO categories (id, name, name_key) SELECT ?, ?, ?
         WHERE (SELECT COUNT(*) FROM categories) < ? RETURNING id, name, revision`
      )
      .bind(id, clean.name, clean.key, MAX_CATEGORIES)
      .first<{ id: string; name: string; revision: number }>();
    if (!row) return { ...err("cap_reached"), limit: MAX_CATEGORIES };
    return { category_id: row.id, name: row.name, revision: row.revision, created: true };
  } catch (e) {
    if (!isUnique(e)) throw e;
    // A concurrent create won the name: return that category.
    const winner = await categoryByKey(db, clean.key);
    if (!winner) throw e;
    return { category_id: winner.id, name: winner.name, revision: winner.revision, created: false };
  }
}

export async function renameCategory(db: Db, args: { category_id: string; name: string; expected_revision: number; dry_run?: boolean }) {
  if (!enforceArgBudget(args)) return tooLarge();
  const clean = cleanCategoryName(args.name);
  if (!clean.ok) return clean.error;
  const current = await categoryById(db, args.category_id);
  if (!current) return err("not_found");
  if (current.name === clean.name) return { category_id: current.id, name: current.name, revision: current.revision, unchanged: true };
  if (current.revision !== args.expected_revision) return { ...err("revision_conflict"), current_revision: current.revision };
  const owner = await categoryByKey(db, clean.key);
  if (owner && owner.id !== current.id) return err("name_collision");
  if (args.dry_run) return { dry_run: true, would: "rename", category_id: current.id, name: clean.name };
  if (!(await checkMutationBudget(db))) return err("rate_limited");
  try {
    const row = await db.database
      .prepare(
        `UPDATE categories SET name = ?, name_key = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE id = ? AND revision = ? RETURNING revision`
      )
      .bind(clean.name, clean.key, current.id, args.expected_revision)
      .first<{ revision: number }>();
    if (!row) return err("revision_conflict");
    return { category_id: current.id, name: clean.name, revision: row.revision };
  } catch (e) {
    if (isUnique(e)) return err("name_collision");
    throw e;
  }
}

export async function listCategories(db: Db, args: Record<string, never> = {}) {
  if (!enforceArgBudget(args)) return tooLarge();
  const r = await db.database
    .prepare(
      `SELECT c.id, c.name, c.revision,
         (SELECT COUNT(*) FROM categorization_rules r WHERE r.category_id = c.id) AS rules
       FROM categories c ORDER BY c.name_key, c.id`
    )
    .all<{ id: string; name: string; revision: number; rules: number }>();
  return {
    categories: r.results.map((c) => ({ category_id: c.id, name: c.name, revision: c.revision, rules: c.rules })),
    count: r.results.length,
    limit: MAX_CATEGORIES,
  };
}

// ---- tools: rules ----

interface PreviewArgs {
  rule: unknown;
  rule_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

/** Bounded, cache-only impact sample for a rule; nothing is written. */
async function previewSample(db: Db, rule: NormalizedRule, categoryName: string, opts: { ruleId?: string; createdAt?: string; dateFrom?: string; dateTo?: string; limit: number }) {
  const existingRows = await allRules(db);
  const candidateId = opts.ruleId ?? "(candidate)";
  const candidateRow: RuleRow = {
    ...rule,
    id: candidateId,
    category_name: categoryName,
    revision: 1,
    // A new rule is created after every existing one, so it loses equal-priority ties.
    created_at: opts.createdAt ?? "9999-12-31 23:59:59.999",
  };
  const candidate = compileRule(candidateRow);
  if (!candidate) return err("invalid_argument", "rule", "invalid");
  const withoutSelf = existingRows.filter((r) => r.id !== candidateId);
  const current = new RuleSet(opts.ruleId ? existingRows : withoutSelf);
  const proposed = new RuleSet([...withoutSelf, candidateRow]);

  let accountUids: string[] | null = null;
  if (rule.account_identity_id !== null) {
    accountUids = await db.accountUidsForIdentity(rule.account_identity_id);
  }
  const rows = accountUids !== null && accountUids.length === 0
    ? []
    : await bookedRowsForCategories(db, { accountUids, dateFrom: opts.dateFrom, dateTo: opts.dateTo, limit: opts.limit + 1 });
  const truncated = rows.length > opts.limit;
  const scanned = rows.slice(0, opts.limit);
  const before = await annotateTransactions(db, scanned, [], current);
  const after = await annotateTransactions(db, scanned, [], proposed);
  const names = new Map((await db.allAccounts()).map((a) => [a.account_uid, a.name]));

  let matched = 0;
  let wouldWin = 0;
  let keptByOverride = 0;
  let changes = 0;
  const beatenBy = new Map<string, number>();
  const sample: unknown[] = [];
  scanned.forEach((row, i) => {
    const ref = before.booked[i].account_ref;
    if (after.booked[i].category_id !== before.booked[i].category_id) changes++;
    if (ruleMatches(candidate, { ...row, account_identity_id: ref }) !== "match") return;
    matched++;
    const a = after.booked[i];
    if (a.category_source === "manual" || a.category_warning === "override_identity_conflict") keptByOverride++;
    else if (a.category_rule_id === candidate.id) wouldWin++;
    else if (a.category_rule_id) beatenBy.set(a.category_rule_id, (beatenBy.get(a.category_rule_id) ?? 0) + 1);
    if (sample.length < 20) {
      sample.push({
        account: names.get(row.account_uid) ?? null,
        booking_date: row.booking_date,
        amount_cents: signedCents(row),
        currency: row.currency,
        counterparty: row.counterparty,
        description: row.remittance_info,
        transaction_key: a.transaction_key,
        category: before.booked[i].category,
        category_after: a.category,
      });
    }
  });
  return {
    scanned: scanned.length,
    truncated,
    matched,
    would_win: wouldWin,
    kept_by_manual_override: keptByOverride,
    beaten_by_rules: [...beatenBy.entries()].map(([rule_id, rows]) => ({ rule_id, rows })),
    category_changes: changes,
    sample,
    note: truncated
      ? `Sample of the newest ${scanned.length} booked rows only; counts are not full-history totals.`
      : "Counts cover every cached booked row in the requested range.",
  };
}

export async function previewRule(db: Db, args: PreviewArgs) {
  if (!enforceArgBudget(args)) return tooLarge();
  const norm = await normalizeRule(db, args.rule);
  if (!norm.ok) return norm.error;
  let createdAt: string | undefined;
  if (args.rule_id) {
    const existing = await storedRule(db, args.rule_id);
    if (!existing) return err("not_found", "rule_id");
    createdAt = existing.created_at;
  }
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const preview = await previewSample(db, norm.rule, norm.categoryName, {
    ruleId: args.rule_id, createdAt, dateFrom: args.date_from, dateTo: args.date_to, limit,
  });
  if ("error" in preview) return preview;
  return { rule: ruleOut({ ...norm.rule, id: args.rule_id ?? "(candidate)", revision: 0, created_at: createdAt ?? "" }, norm.categoryName), ...preview };
}

export async function addRule(db: Db, args: { rule_id: string; rule: unknown; dry_run?: boolean }) {
  if (!enforceArgBudget(args)) return tooLarge();
  if (!CategoryIdSchema.safeParse(args.rule_id).success) return err("invalid_argument", "rule_id", "invalid");
  const norm = await normalizeRule(db, args.rule);
  if (!norm.ok) return norm.error;
  const existing = await storedRule(db, args.rule_id);
  if (existing) {
    // Client-UUID idempotency: a retry with identical content is a no-op; different content is never an implicit overwrite.
    if (!sameRuleContent(norm.rule, existing)) return err("idempotency_conflict");
    return { rule: ruleOut(existing, norm.categoryName, await accountDisplay(db)), unchanged: true };
  }
  if (args.dry_run) {
    const preview = await previewSample(db, norm.rule, norm.categoryName, { ruleId: args.rule_id, limit: 100 });
    return { dry_run: true, would: "create", rule: ruleOut({ ...norm.rule, id: args.rule_id, revision: 1, created_at: "" }, norm.categoryName), preview };
  }
  if (!(await checkMutationBudget(db))) return err("rate_limited");
  const r = norm.rule;
  try {
    const row = await db.database
      .prepare(
        `INSERT INTO categorization_rules (id, category_id, account_identity_id, priority, enabled, direction,
           counterparty_mode, counterparty_pattern, remittance_mode, remittance_pattern,
           amount_min_cents, amount_max_cents, currency, booking_day_from, booking_day_to)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM categorization_rules) < ?
         RETURNING *`
      )
      .bind(args.rule_id, r.category_id, r.account_identity_id, r.priority, r.enabled, r.direction,
        r.counterparty_mode, r.counterparty_pattern, r.remittance_mode, r.remittance_pattern,
        r.amount_min_cents, r.amount_max_cents, r.currency, r.booking_day_from, r.booking_day_to, MAX_RULES)
      .first<StoredRuleRow>();
    if (!row) return { ...err("cap_reached"), limit: MAX_RULES };
    return { rule: ruleOut(row, norm.categoryName, await accountDisplay(db)), created: true };
  } catch (e) {
    if (!isUnique(e)) throw e;
    // A concurrent add with the same UUID won: same content is success, anything else a conflict.
    const winner = await storedRule(db, args.rule_id);
    if (winner && sameRuleContent(norm.rule, winner)) return { rule: ruleOut(winner, norm.categoryName, await accountDisplay(db)), unchanged: true };
    return err("idempotency_conflict");
  }
}

export async function updateRule(db: Db, args: { rule_id: string; rule: unknown; expected_revision: number; dry_run?: boolean }) {
  if (!enforceArgBudget(args)) return tooLarge();
  const norm = await normalizeRule(db, args.rule);
  if (!norm.ok) return norm.error;
  const existing = await storedRule(db, args.rule_id);
  if (!existing) return err("not_found");
  if (existing.revision !== args.expected_revision) {
    // A retried update whose change already landed is reported as done, not as a conflict.
    if (sameRuleContent(norm.rule, existing)) return { rule: ruleOut(existing, norm.categoryName, await accountDisplay(db)), unchanged: true };
    return { ...err("revision_conflict"), current_revision: existing.revision };
  }
  if (sameRuleContent(norm.rule, existing)) return { rule: ruleOut(existing, norm.categoryName, await accountDisplay(db)), unchanged: true };
  if (args.dry_run) {
    const preview = await previewSample(db, norm.rule, norm.categoryName, { ruleId: args.rule_id, createdAt: existing.created_at, limit: 100 });
    return { dry_run: true, would: "update", rule: ruleOut({ ...norm.rule, id: args.rule_id, revision: existing.revision + 1, created_at: existing.created_at }, norm.categoryName), preview };
  }
  if (!(await checkMutationBudget(db))) return err("rate_limited");
  const r = norm.rule;
  const row = await db.database
    .prepare(
      `UPDATE categorization_rules SET category_id = ?, account_identity_id = ?, priority = ?, enabled = ?, direction = ?,
         counterparty_mode = ?, counterparty_pattern = ?, remittance_mode = ?, remittance_pattern = ?,
         amount_min_cents = ?, amount_max_cents = ?, currency = ?, booking_day_from = ?, booking_day_to = ?,
         revision = revision + 1, updated_at = datetime('now')
       WHERE id = ? AND revision = ? RETURNING *`
    )
    .bind(r.category_id, r.account_identity_id, r.priority, r.enabled, r.direction,
      r.counterparty_mode, r.counterparty_pattern, r.remittance_mode, r.remittance_pattern,
      r.amount_min_cents, r.amount_max_cents, r.currency, r.booking_day_from, r.booking_day_to,
      args.rule_id, args.expected_revision)
    .first<StoredRuleRow>();
  if (!row) return err("revision_conflict");
  return { rule: ruleOut(row, norm.categoryName, await accountDisplay(db)) };
}

export async function deleteRule(db: Db, args: { rule_id: string; expected_revision: number; dry_run?: boolean }) {
  if (!enforceArgBudget(args)) return tooLarge();
  const existing = await storedRule(db, args.rule_id);
  if (!existing) return { rule_id: args.rule_id, deleted: false };
  if (existing.revision !== args.expected_revision) return { ...err("revision_conflict"), current_revision: existing.revision };
  if (args.dry_run) return { dry_run: true, would: "delete", rule_id: args.rule_id };
  if (!(await checkMutationBudget(db))) return err("rate_limited");
  const res = await db.database
    .prepare("DELETE FROM categorization_rules WHERE id = ? AND revision = ?")
    .bind(args.rule_id, args.expected_revision)
    .run();
  if ((res.meta.changes ?? 0) > 0) return { rule_id: args.rule_id, deleted: true };
  return (await storedRule(db, args.rule_id)) ? err("revision_conflict") : { rule_id: args.rule_id, deleted: false };
}

/**
 * Opaque list_rules cursor: the evaluation-order position (priority,
 * created_at, id) of the last rule on the page, so a page boundary survives
 * that rule being deleted, disabled or filtered out in between.
 */
function encodeRuleCursor(r: { priority: number; created_at: string; id: string }): string {
  return btoa(JSON.stringify([r.priority, r.created_at, r.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeRuleCursor(cursor: string): { priority: number; createdAt: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [priority, createdAt, id] = v;
    if (!Number.isSafeInteger(priority) || typeof createdAt !== "string" || typeof id !== "string") return null;
    return { priority, createdAt, id };
  } catch {
    return null;
  }
}

export async function listRules(db: Db, args: { account_ref?: string; category_id?: string; enabled?: boolean; limit?: number; cursor?: string }) {
  if (!enforceArgBudget(args)) return tooLarge();
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 100);
  const all = await allRules(db);
  let filtered = all.filter(
    (r) =>
      (args.account_ref === undefined || r.account_identity_id === null || r.account_identity_id === args.account_ref) &&
      (args.category_id === undefined || r.category_id === args.category_id) &&
      (args.enabled === undefined || (r.enabled === 1) === args.enabled)
  );
  if (args.cursor !== undefined) {
    const pos = decodeRuleCursor(args.cursor);
    if (pos === null) return err("invalid_argument", "cursor", "invalid");
    filtered = filtered.filter((r) => compareRules({ priority: r.priority, createdAt: r.created_at, id: r.id }, pos) > 0);
  }
  const page = filtered.slice(0, limit);
  const accounts = await accountDisplay(db);
  const rank = new Map(all.filter((r) => r.enabled === 1).map((r, i) => [r.id, i + 1]));
  return {
    rules: page.map((r) => ({ ...ruleOut(r, r.category_name, accounts), rank: rank.get(r.id) ?? null })),
    count: page.length,
    total_rules: all.length,
    limit: MAX_RULES,
    next_cursor: filtered.length > limit ? encodeRuleCursor(page[page.length - 1]) : null,
    note: "Rules are listed in evaluation order: priority high to low, then oldest first. rank is the position among enabled rules; the first matching rule wins unless a manual override exists.",
  };
}

// ---- tools: manual overrides ----

interface ResolvedTarget {
  identityId: string;
  key: string;
  guards: { booking_date: string; amount_cents: number; currency: string; credit_debit: "CRDT" | "DBIT" };
  row: BookedRow;
}

/**
 * Resolve a booked cached row by stable identity, expected facts and derived
 * key. Never queries the bank; identical copies across generations are one
 * target, incompatible copies are an identity conflict.
 */
async function resolveTarget(
  db: Db,
  identityId: string,
  key: string,
  expected: { booking_date: string; amount_cents: number; currency: string }
): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; error: ToolError }> {
  const r = await db.database
    .prepare(
      `SELECT t.account_uid, t.booking_date, t.amount_cents, t.currency, t.credit_debit, t.counterparty, t.remittance_info, t.dedup_key
         FROM transactions t JOIN accounts a ON a.account_uid = t.account_uid
        WHERE a.account_identity_id = ? AND t.booking_date = ? AND t.currency = ?
          AND (CASE WHEN t.credit_debit = 'DBIT' THEN -ABS(t.amount_cents) ELSE ABS(t.amount_cents) END) = ?
        LIMIT ?`
    )
    .bind(identityId, expected.booking_date, expected.currency, expected.amount_cents, MAX_OVERRIDE_CANDIDATES + 1)
    .all<BookedRow>();
  if (r.results.length > MAX_OVERRIDE_CANDIDATES) return { ok: false, error: err("too_many_candidates") };
  const hits: BookedRow[] = [];
  for (const row of r.results) if ((await transactionKey(row.dedup_key)) === key) hits.push(row);
  if (hits.length === 0) return { ok: false, error: err("not_cached") };
  const first = hits[0];
  if (first.credit_debit !== "CRDT" && first.credit_debit !== "DBIT") return { ok: false, error: err("identity_conflict") };
  if (hits.some((h) => h.credit_debit !== first.credit_debit || Math.abs(h.amount_cents) !== Math.abs(first.amount_cents))) {
    return { ok: false, error: err("identity_conflict") };
  }
  return {
    ok: true,
    target: {
      identityId,
      key,
      row: first,
      guards: { booking_date: first.booking_date, amount_cents: Math.abs(first.amount_cents), currency: first.currency, credit_debit: first.credit_debit },
    },
  };
}

export async function categorizeTransaction(
  db: Db,
  args: {
    account_ref: string;
    transaction_key: string;
    expected: { booking_date: string; amount_cents: number; currency: string };
    category_id: string | null;
    expected_revision: number;
    dry_run?: boolean;
  }
) {
  if (!enforceArgBudget(args)) return tooLarge();
  if (!(await db.identityById(args.account_ref))) return err("not_found", "account_ref");
  let categoryName: string | null = null;
  if (args.category_id !== null) {
    const c = await categoryById(db, args.category_id);
    if (!c) return err("not_found", "category_id");
    categoryName = c.name;
  }
  const resolved = await resolveTarget(db, args.account_ref, args.transaction_key, args.expected);
  if (!resolved.ok) return resolved.error;
  const { guards } = resolved.target;
  const current = await overrideFor(db, args.account_ref, args.transaction_key);
  const result = (revision: number, extra: Record<string, unknown> = {}) => ({
    account_ref: args.account_ref,
    transaction_key: args.transaction_key,
    category: categoryName,
    category_id: args.category_id,
    category_source: "manual",
    revision,
    ...extra,
  });

  if (current) {
    const guardsMatch = current.booking_date === guards.booking_date && current.amount_cents === guards.amount_cents &&
      current.currency === guards.currency && current.credit_debit === guards.credit_debit;
    if (!guardsMatch) return err("identity_conflict");
    if (current.category_id === args.category_id) return result(current.revision, { unchanged: true });
    if (current.revision !== args.expected_revision) return { ...err("revision_conflict"), current_revision: current.revision };
  } else if (args.expected_revision !== 0) {
    return { ...err("revision_conflict"), current_revision: 0 };
  }
  if (args.dry_run) return { dry_run: true, would: current ? "update" : "create", ...result(current ? current.revision + 1 : 1) };
  if (!(await checkMutationBudget(db))) return err("rate_limited");

  if (!current) {
    const row = await db.database
      .prepare(
        `INSERT INTO transaction_category_overrides
           (account_identity_id, transaction_key, category_id, booking_date, amount_cents, currency, credit_debit)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM transaction_category_overrides) < ?
         ON CONFLICT(account_identity_id, transaction_key) DO NOTHING
         RETURNING revision`
      )
      .bind(args.account_ref, args.transaction_key, args.category_id, guards.booking_date, guards.amount_cents,
        guards.currency, guards.credit_debit, MAX_OVERRIDES)
      .first<{ revision: number }>();
    if (row) return result(row.revision);
    const raced = await overrideFor(db, args.account_ref, args.transaction_key);
    if (!raced) return { ...err("cap_reached"), limit: MAX_OVERRIDES };
    if (raced.category_id === args.category_id) return result(raced.revision, { unchanged: true });
    return { ...err("revision_conflict"), current_revision: raced.revision };
  }
  // Guards are part of the WHERE: an override is never re-pointed at a row with different facts.
  const row = await db.database
    .prepare(
      `UPDATE transaction_category_overrides SET category_id = ?, revision = revision + 1, updated_at = datetime('now')
       WHERE account_identity_id = ? AND transaction_key = ? AND revision = ?
         AND booking_date = ? AND amount_cents = ? AND currency = ? AND credit_debit = ?
       RETURNING revision`
    )
    .bind(args.category_id, args.account_ref, args.transaction_key, args.expected_revision,
      guards.booking_date, guards.amount_cents, guards.currency, guards.credit_debit)
    .first<{ revision: number }>();
  if (!row) return err("revision_conflict");
  return result(row.revision);
}

export async function clearTransactionCategory(
  db: Db,
  args: { account_ref: string; transaction_key: string; expected_revision: number; dry_run?: boolean }
) {
  if (!enforceArgBudget(args)) return tooLarge();
  if (!(await db.identityById(args.account_ref))) return err("not_found", "account_ref");
  const current = await overrideFor(db, args.account_ref, args.transaction_key);
  if (!current) return { account_ref: args.account_ref, transaction_key: args.transaction_key, deleted: false };
  if (current.revision !== args.expected_revision) return { ...err("revision_conflict"), current_revision: current.revision };

  // What applies once the override is gone, from the cached row its guards still identify (if any).
  const effective = async () => {
    const resolved = await resolveTarget(db, args.account_ref, args.transaction_key, {
      booking_date: current.booking_date,
      amount_cents: current.credit_debit === "DBIT" ? -current.amount_cents : current.amount_cents,
      currency: current.currency,
    });
    if (!resolved.ok) return { category_evaluation: "not_cached" };
    const r = evaluate({ ...resolved.target.row, account_identity_id: args.account_ref }, await loadRuleSet(db), null);
    return { category: r.category, category_id: r.category_id, category_source: r.category_source, category_rule_id: r.category_rule_id };
  };

  if (args.dry_run) return { dry_run: true, would: "delete", account_ref: args.account_ref, transaction_key: args.transaction_key, after: await effective() };
  if (!(await checkMutationBudget(db))) return err("rate_limited");
  const res = await db.database
    .prepare("DELETE FROM transaction_category_overrides WHERE account_identity_id = ? AND transaction_key = ? AND revision = ?")
    .bind(args.account_ref, args.transaction_key, args.expected_revision)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    return (await overrideFor(db, args.account_ref, args.transaction_key))
      ? err("revision_conflict")
      : { account_ref: args.account_ref, transaction_key: args.transaction_key, deleted: false };
  }
  return { account_ref: args.account_ref, transaction_key: args.transaction_key, deleted: true, after: await effective() };
}
