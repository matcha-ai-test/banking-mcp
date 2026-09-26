/**
 * Pure category evaluator. No Env, Db, fetch or bank client: the caller loads
 * rules, overrides and cached rows, and this module decides one category per
 * row deterministically. Matching is literal (exact or substring) over
 * normalized text; no user-supplied value is ever compiled into a RegExp, SQL
 * fragment or code.
 */
import { normalizeText } from "./util";

export type Direction = "in" | "out" | "any";
export type TextMode = "exact" | "contains";

/** Cached text longer than these limits is never matched (and never truncated to force a match). */
export const MAX_COUNTERPARTY_CHARS = 512;
export const MAX_REMITTANCE_CHARS = 4096;

/** Matching key: NFKC, invisible characters dropped, whitespace collapsed, lowercased (locale-independent). */
export function matchKey(v: string): string {
  return normalizeText(v).toLowerCase();
}

/** A rule as stored in D1 (categorization_rules joined with the category name). */
export interface RuleRow {
  id: string;
  category_id: string;
  category_name: string;
  account_identity_id: string | null;
  priority: number;
  enabled: number;
  direction: string;
  counterparty_mode: string | null;
  counterparty_pattern: string | null;
  remittance_mode: string | null;
  remittance_pattern: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  currency: string | null;
  booking_day_from: number | null;
  booking_day_to: number | null;
  revision: number;
  created_at: string;
}

export interface CompiledRule {
  id: string;
  categoryId: string;
  categoryName: string;
  accountIdentityId: string | null;
  priority: number;
  createdAt: string;
  direction: Direction;
  counterparty: { mode: TextMode; key: string } | null;
  remittance: { mode: TextMode; key: string } | null;
  amountMin: number | null;
  amountMax: number | null;
  currency: string | null;
  dayFrom: number | null;
  dayTo: number | null;
}

export interface OverrideRow {
  account_identity_id: string;
  transaction_key: string;
  category_id: string | null;
  category_name: string | null;
  booking_date: string;
  amount_cents: number;
  currency: string;
  credit_debit: string;
  revision: number;
}

/** The subset of a cached transaction the evaluator reads. */
export interface EvalRow {
  account_identity_id: string | null;
  booking_date: string;
  amount_cents: number;
  currency: string;
  credit_debit: string;
  counterparty: string | null;
  remittance_info: string | null;
}

export interface CategoryResult {
  category: string | null;
  category_id: string | null;
  category_source: "manual" | "rule" | "uncategorized";
  category_rule_id: string | null;
  category_override_revision: number | null;
  /** Only present when true: more than one rule with different categories matched, or the winner is a short contains pattern. */
  category_uncertain?: true;
  /** Only present on an integrity or input problem; the row is then uncategorized (fail closed). */
  category_warning?: "override_identity_conflict" | "text_too_long" | "rules_unavailable";
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** Deterministic evaluation order: priority DESC, created_at ASC, id ASC (binary, not locale). */
export function compareRules(a: { priority: number; createdAt: string; id: string }, b: { priority: number; createdAt: string; id: string }): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compile one stored rule, re-validating every invariant the DDL also enforces.
 * Returns null for a malformed row. The write path runs this exact function
 * on the row it is about to store (single source of validation); RuleSet
 * keeps a malformed row's position so it fails closed only for rows it could
 * have won.
 */
export function compileRule(r: RuleRow): CompiledRule | null {
  if (r.direction !== "in" && r.direction !== "out" && r.direction !== "any") return null;
  if (!isInt(r.priority) || r.priority < 0 || r.priority > 1000) return null;
  const text = (mode: string | null, pattern: string | null, max: number) => {
    if (mode === null && pattern === null) return undefined;
    if ((mode !== "exact" && mode !== "contains") || typeof pattern !== "string") return null;
    // Length is checked on the stored text and on the lowercased key: lowercasing
    // can lengthen a string (U+0130 becomes two code units).
    const key = matchKey(pattern);
    if (pattern.length > max || key.length < 1 || key.length > max || (mode === "contains" && key.length < 3)) return null;
    return { mode: mode as TextMode, key };
  };
  const counterparty = text(r.counterparty_mode, r.counterparty_pattern, 160);
  const remittance = text(r.remittance_mode, r.remittance_pattern, 256);
  if (counterparty === null || remittance === null) return null;
  const min = r.amount_min_cents;
  const max = r.amount_max_cents;
  if ((min !== null && (!isInt(min) || min < 0)) || (max !== null && (!isInt(max) || max < 0))) return null;
  if (min !== null && max !== null && min > max) return null;
  if (r.currency !== null && !/^[A-Z]{3}$/.test(r.currency)) return null;
  if ((min !== null || max !== null) && r.currency === null) return null;
  const from = r.booking_day_from;
  const to = r.booking_day_to;
  if ((from === null) !== (to === null)) return null;
  if (from !== null && to !== null && (!isInt(from) || !isInt(to) || from < 1 || to > 31 || from > to)) return null;
  if (r.account_identity_id === null && !counterparty && !remittance && min === null && max === null) return null;
  return {
    id: r.id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    accountIdentityId: r.account_identity_id,
    priority: r.priority,
    createdAt: r.created_at,
    direction: r.direction,
    counterparty: counterparty ?? null,
    remittance: remittance ?? null,
    amountMin: min,
    amountMax: max,
    currency: r.currency,
    dayFrom: from,
    dayTo: to,
  };
}

/** A unique symbol, so no real bank text can ever collide with the sentinel. */
const TOO_LONG: unique symbol = Symbol("too_long");
type RowTextValue = string | null | typeof TOO_LONG;

/** Per-row lazily normalized text, so each field is normalized at most once per row. */
export class RowText {
  private cp: { v: RowTextValue } | null = null;
  private rem: { v: RowTextValue } | null = null;
  private row: EvalRow;
  constructor(row: EvalRow) {
    this.row = row;
  }
  private static norm(raw: string | null, max: number): { v: RowTextValue } {
    if (raw == null || raw.length === 0) return { v: null };
    if (raw.length > max) return { v: TOO_LONG };
    return { v: matchKey(raw) || null };
  }
  /** Normalized text, null when empty or absent, TOO_LONG when over the cap. */
  counterparty(): RowTextValue {
    this.cp ??= RowText.norm(this.row.counterparty, MAX_COUNTERPARTY_CHARS);
    return this.cp.v;
  }
  remittance(): RowTextValue {
    this.rem ??= RowText.norm(this.row.remittance_info, MAX_REMITTANCE_CHARS);
    return this.rem.v;
  }
}

function bookingDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return Number(m[3]);
}

type MatchOutcome = "match" | "no" | "too_long";

function textMatches(pred: { mode: TextMode; key: string }, value: RowTextValue): MatchOutcome {
  if (value === TOO_LONG) return "too_long";
  if (value === null) return "no";
  return pred.mode === "exact" ? (value === pred.key ? "match" : "no") : value.includes(pred.key) ? "match" : "no";
}

/** Does one compiled rule match one row? Direction is never inferred from the amount sign. */
export function ruleMatches(rule: CompiledRule, row: EvalRow, text: RowText = new RowText(row)): MatchOutcome {
  if (row.credit_debit !== "CRDT" && row.credit_debit !== "DBIT") return "no";
  if (rule.accountIdentityId !== null && rule.accountIdentityId !== row.account_identity_id) return "no";
  if (rule.direction === "out" && row.credit_debit !== "DBIT") return "no";
  if (rule.direction === "in" && row.credit_debit !== "CRDT") return "no";
  if (rule.currency !== null && rule.currency !== row.currency) return "no";
  if (rule.amountMin !== null || rule.amountMax !== null) {
    if (!isInt(row.amount_cents)) return "no";
    const abs = Math.abs(row.amount_cents);
    if (rule.amountMin !== null && abs < rule.amountMin) return "no";
    if (rule.amountMax !== null && abs > rule.amountMax) return "no";
  }
  if (rule.dayFrom !== null && rule.dayTo !== null) {
    const day = bookingDay(row.booking_date);
    if (day === null || day < rule.dayFrom || day > rule.dayTo) return "no";
  }
  if (rule.counterparty) {
    const m = textMatches(rule.counterparty, text.counterparty());
    if (m !== "match") return m;
  }
  if (rule.remittance) {
    const m = textMatches(rule.remittance, text.remittance());
    if (m !== "match") return m;
  }
  return "match";
}

/**
 * A stored rule that failed validation. It keeps its (best-effort) place in
 * the evaluation order and its account scope, so it can only affect rows it
 * could have applied to, and only when it would have been evaluated before
 * the winner.
 */
export interface MalformedRule {
  malformed: true;
  id: string;
  accountIdentityId: string | null;
  priority: number;
  createdAt: string;
}

type RuleEntry = CompiledRule | MalformedRule;
const isMalformed = (r: RuleEntry): r is MalformedRule => "malformed" in r;

/** Immutable, ordered rule snapshot for one request. */
export class RuleSet {
  readonly rules: CompiledRule[];
  /** Ids of enabled stored rules that failed validation. */
  readonly malformedIds: string[];
  private ordered: RuleEntry[];
  private byIdentity = new Map<string, RuleEntry[]>();

  constructor(rows: RuleRow[]) {
    const entries: RuleEntry[] = [];
    for (const r of rows) {
      if (r.enabled !== 1) continue;
      const c = compileRule(r);
      if (c !== null) {
        entries.push(c);
        continue;
      }
      // An unreadable priority sorts first: it could have outranked anything.
      const priority = isInt(r.priority) && r.priority >= 0 && r.priority <= 1000 ? r.priority : Number.MAX_SAFE_INTEGER;
      entries.push({
        malformed: true,
        id: String(r.id),
        accountIdentityId: typeof r.account_identity_id === "string" ? r.account_identity_id : null,
        priority,
        createdAt: typeof r.created_at === "string" ? r.created_at : "",
      });
    }
    entries.sort(compareRules);
    this.ordered = entries;
    this.rules = entries.filter((e): e is CompiledRule => !isMalformed(e));
    this.malformedIds = entries.filter(isMalformed).map((e) => e.id);
  }

  /** Global rules plus the rules scoped to this identity, already in evaluation order. */
  candidates(identityId: string | null): RuleEntry[] {
    const key = identityId ?? "";
    let list = this.byIdentity.get(key);
    if (!list) {
      list = this.ordered.filter((r) => r.accountIdentityId === null || r.accountIdentityId === identityId);
      this.byIdentity.set(key, list);
    }
    return list;
  }
}

const UNCATEGORIZED: CategoryResult = {
  category: null,
  category_id: null,
  category_source: "uncategorized",
  category_rule_id: null,
  category_override_revision: null,
};

/** An override applies only while every stored guard still equals the row's facts. */
export function overrideGuardsHold(o: OverrideRow, row: EvalRow): boolean {
  return (
    o.booking_date === row.booking_date &&
    o.amount_cents === Math.abs(row.amount_cents) &&
    o.currency === row.currency &&
    o.credit_debit === row.credit_debit
  );
}

/**
 * Precedence: a guard-valid manual override (including an explicit null
 * category) wins; otherwise the first matching enabled rule in evaluation
 * order; otherwise uncategorized. A present override whose guards conflict
 * fails closed: uncategorized with a warning, never a lower-precedence rule.
 */
export function evaluate(row: EvalRow, rules: RuleSet, override: OverrideRow | null): CategoryResult {
  if (override) {
    if (!overrideGuardsHold(override, row)) {
      return { ...UNCATEGORIZED, category_override_revision: override.revision, category_warning: "override_identity_conflict" };
    }
    // An explicit null override is still a manual decision: it reports
    // source "manual" with category null and blocks every rule.
    return {
      category: override.category_id === null ? null : override.category_name,
      category_id: override.category_id,
      category_source: "manual",
      category_rule_id: null,
      category_override_revision: override.revision,
    };
  }
  const text = new RowText(row);
  let winner: CompiledRule | null = null;
  let tooLong = false;
  let uncertain = false;
  for (const rule of rules.candidates(row.account_identity_id)) {
    if (isMalformed(rule)) {
      // Fail closed only where it matters: a malformed rule ranked before any
      // match might have been the winner, so this row is left uncategorized.
      // Rows already won by a higher-ranked rule, and rows outside the
      // malformed rule's account scope, are unaffected.
      if (winner === null) return { ...UNCATEGORIZED, category_warning: "rules_unavailable" };
      continue;
    }
    const m = ruleMatches(rule, row, text);
    if (m === "too_long") {
      tooLong = true;
      continue;
    }
    if (m !== "match") continue;
    if (winner === null) {
      winner = rule;
      if (rule.counterparty?.mode === "contains" && rule.counterparty.key.length < 5) uncertain = true;
      if (rule.remittance?.mode === "contains" && rule.remittance.key.length < 5) uncertain = true;
      continue;
    }
    if (rule.categoryId !== winner.categoryId) {
      uncertain = true;
      break;
    }
  }
  const warning = tooLong ? { category_warning: "text_too_long" as const } : {};
  if (winner === null) return { ...UNCATEGORIZED, ...warning };
  return {
    category: winner.categoryName,
    category_id: winner.categoryId,
    category_source: "rule",
    category_rule_id: winner.id,
    category_override_revision: null,
    ...(uncertain ? { category_uncertain: true as const } : {}),
    ...warning,
  };
}
