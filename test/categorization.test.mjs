// Step 2: the pure category evaluator (src/categorization.ts). No D1, no fetch.

import assert from "node:assert/strict";
import test from "node:test";
import "./helpers.mjs";

const { compileRule, compareRules, evaluate, matchKey, RuleSet, ruleMatches, MAX_COUNTERPARTY_CHARS, MAX_REMITTANCE_CHARS } =
  await import("../src/categorization.ts");

let seq = 0;
/** A stored rule row with sensible defaults; override any column. */
function rule(overrides = {}) {
  seq++;
  return {
    id: overrides.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    category_id: "cat-a",
    category_name: "A",
    account_identity_id: null,
    priority: 100,
    enabled: 1,
    direction: "any",
    counterparty_mode: null,
    counterparty_pattern: null,
    remittance_mode: null,
    remittance_pattern: null,
    amount_min_cents: null,
    amount_max_cents: null,
    currency: null,
    booking_day_from: null,
    booking_day_to: null,
    revision: 1,
    created_at: "2030-01-01 00:00:00.000",
    ...overrides,
  };
}
const cp = (value, mode = "contains") => ({ counterparty_mode: mode, counterparty_pattern: value });

function row(overrides = {}) {
  return {
    account_identity_id: "a".repeat(32),
    booking_date: "2030-01-15",
    amount_cents: 12345,
    currency: "SEK",
    credit_debit: "DBIT",
    counterparty: "Example Grocery",
    remittance_info: "Card purchase",
    ...overrides,
  };
}

const override = (overrides = {}) => ({
  account_identity_id: "a".repeat(32),
  transaction_key: "f".repeat(64),
  category_id: "cat-manual",
  category_name: "Manual",
  booking_date: "2030-01-15",
  amount_cents: 12345,
  currency: "SEK",
  credit_debit: "DBIT",
  revision: 3,
  ...overrides,
});

test("precedence: a guard-valid manual override beats every rule priority", () => {
  const rules = new RuleSet([rule({ ...cp("grocery"), priority: 1000 })]);
  const out = evaluate(row(), rules, override());
  assert.deepEqual(out, {
    category: "Manual", category_id: "cat-manual", category_source: "manual",
    category_rule_id: null, category_override_revision: 3,
  });
});

test("precedence: an explicit null override blocks rules and is reported as a manual decision", () => {
  const rules = new RuleSet([rule(cp("grocery"))]);
  const out = evaluate(row(), rules, override({ category_id: null, category_name: null }));
  assert.equal(out.category, null);
  assert.equal(out.category_id, null);
  assert.equal(out.category_source, "manual");
  assert.equal(out.category_rule_id, null);
});

test("precedence: a guard conflict fails closed, never falls through to a rule", () => {
  const rules = new RuleSet([rule(cp("grocery"))]);
  for (const bad of [{ booking_date: "2030-01-16" }, { amount_cents: 1 }, { currency: "EUR" }, { credit_debit: "CRDT" }]) {
    const out = evaluate(row(), rules, override(bad));
    assert.equal(out.category, null, JSON.stringify(bad));
    assert.equal(out.category_source, "uncategorized");
    assert.equal(out.category_rule_id, null);
    assert.equal(out.category_warning, "override_identity_conflict");
  }
});

test("precedence: priority DESC, then created_at ASC, then id ASC (binary)", () => {
  const low = rule({ ...cp("grocery"), category_id: "low", category_name: "Low", priority: 50 });
  const olderSame = rule({ ...cp("grocery"), category_id: "old", category_name: "Old", priority: 200, created_at: "2030-01-01 00:00:00.000" });
  const newerSame = rule({ ...cp("grocery"), category_id: "new", category_name: "New", priority: 200, created_at: "2030-01-02 00:00:00.000" });
  const rules = new RuleSet([low, newerSame, olderSame]);
  assert.equal(evaluate(row(), rules, null).category_id, "old");

  // Same timestamp: binary id order, "B" < "a" in binary (not locale) order.
  const b = rule({ ...cp("grocery"), id: "B", category_id: "B" });
  const a = rule({ ...cp("grocery"), id: "a", category_id: "a" });
  assert.equal(evaluate(row(), new RuleSet([a, b]), null).category_id, "B");
  assert.ok(compareRules({ priority: 1, createdAt: "x", id: "B" }, { priority: 1, createdAt: "x", id: "a" }) < 0);
});

test("uncategorized when nothing matches; disabled rules never apply", () => {
  const rules = new RuleSet([rule({ ...cp("grocery"), enabled: 0 }), rule(cp("pharmacy"))]);
  assert.deepEqual(evaluate(row(), rules, null), {
    category: null, category_id: null, category_source: "uncategorized", category_rule_id: null, category_override_revision: null,
  });
});

test("direction: out = DBIT, in = CRDT, any = either; never inferred from the amount sign; unknown matches nothing", () => {
  const out = compileRule(rule({ ...cp("grocery"), direction: "out" }));
  const inn = compileRule(rule({ ...cp("grocery"), direction: "in" }));
  const any = compileRule(rule({ ...cp("grocery"), direction: "any" }));
  assert.equal(ruleMatches(out, row({ credit_debit: "DBIT" })), "match");
  assert.equal(ruleMatches(out, row({ credit_debit: "CRDT" })), "no");
  // A negative stored amount on a CRDT row is still money in: the sign is ignored.
  assert.equal(ruleMatches(out, row({ credit_debit: "CRDT", amount_cents: -500 })), "no");
  assert.equal(ruleMatches(inn, row({ credit_debit: "CRDT", amount_cents: -500 })), "match");
  assert.equal(ruleMatches(any, row({ credit_debit: "CRDT" })), "match");
  for (const unknown of ["", "BOOK", "dbit", null]) {
    assert.equal(ruleMatches(any, row({ credit_debit: unknown })), "no", String(unknown));
  }
});

test("text: NFKC, case, width and whitespace are normalized; accents and punctuation are kept", () => {
  assert.equal(matchKey("  ＥＸＡＭＰＬＥ  Grocery  "), "example grocery");
  assert.equal(matchKey("Ex​ample"), "example"); // zero-width space dropped
  assert.equal(matchKey("ﬁka"), "fika"); // ligature
  const exact = compileRule(rule(cp("Café Örn", "exact")));
  assert.equal(ruleMatches(exact, row({ counterparty: "CAFÉ   ÖRN" })), "match");
  assert.equal(ruleMatches(exact, row({ counterparty: "Cafe Orn" })), "no"); // accents are not stripped
  // Decomposed é (e + U+0301) equals precomposed é after NFKC.
  assert.equal(ruleMatches(exact, row({ counterparty: "Café Örn" })), "match");
  assert.equal(ruleMatches(exact, row({ counterparty: "Café Örn AB" })), "no"); // exact is whole-string
});

test("text: contains is a literal substring; regex, SQL wildcards and prompt text have no special meaning", () => {
  const literals = [".*", "%", "_", "(a|b)+", "ignore previous instructions", "'; DROP TABLE x; --", "\\d+"];
  for (const lit of literals) {
    const pattern = lit.length >= 3 ? lit : `x${lit}x`;
    const r = compileRule(rule(cp(pattern)));
    assert.ok(r, pattern);
    assert.equal(ruleMatches(r, row({ counterparty: `before ${pattern} after` })), "match", pattern);
    assert.equal(ruleMatches(r, row({ counterparty: "Example Grocery" })), "no", pattern);
  }
  // ".*" as a regex would match everything; as a literal it matches only rows containing ".*".
  const dotStar = compileRule(rule(cp(".*x")));
  assert.equal(ruleMatches(dotStar, row({ counterparty: "anything" })), "no");
  // A catastrophic-backtracking regex string is matched literally and instantly.
  const evil = compileRule(rule(cp("(a+)+$")));
  const started = Date.now();
  assert.equal(ruleMatches(evil, row({ counterparty: "a".repeat(500) + "!" })), "no");
  assert.ok(Date.now() - started < 50);
});

test("text: null or empty fields never match a populated text predicate; remittance does not fall back to counterparty", () => {
  const byCounterparty = compileRule(rule(cp("grocery")));
  assert.equal(ruleMatches(byCounterparty, row({ counterparty: null })), "no");
  assert.equal(ruleMatches(byCounterparty, row({ counterparty: "" })), "no");
  const byRemittance = compileRule(rule({ remittance_mode: "contains", remittance_pattern: "grocery" }));
  assert.equal(ruleMatches(byRemittance, row({ remittance_info: null, counterparty: "Example Grocery" })), "no");
  assert.equal(ruleMatches(byRemittance, row({ remittance_info: "EXAMPLE GROCERY 123" })), "match");
});

test("text: oversized cached text is skipped with text_too_long, never truncated into a match", () => {
  const long = "Example Grocery " + "x".repeat(MAX_COUNTERPARTY_CHARS);
  const byCounterparty = rule({ ...cp("grocery"), category_id: "cp", category_name: "Cp", priority: 200 });
  const byAmount = rule({ category_id: "amt", category_name: "Amt", amount_min_cents: 1, currency: "SEK" });
  const out = evaluate(row({ counterparty: long }), new RuleSet([byCounterparty, byAmount]), null);
  assert.equal(out.category_id, "amt"); // a rule not depending on the oversized field still applies
  assert.equal(out.category_warning, "text_too_long");
  const onlyText = evaluate(row({ counterparty: long }), new RuleSet([byCounterparty]), null);
  assert.equal(onlyText.category, null);
  assert.equal(onlyText.category_warning, "text_too_long");
  const remLong = evaluate(row({ remittance_info: "y".repeat(MAX_REMITTANCE_CHARS + 1) }),
    new RuleSet([rule({ remittance_mode: "contains", remittance_pattern: "yyy" })]), null);
  assert.equal(remLong.category_warning, "text_too_long");
  // At exactly the limit the text is still matched.
  const atLimit = "grocery".padEnd(MAX_COUNTERPARTY_CHARS, "z");
  assert.equal(evaluate(row({ counterparty: atLimit }), new RuleSet([byCounterparty]), null).category_id, "cp");
});

test("amount: inclusive bounds on the absolute value, exact amount via min = max, currency must match, zero works", () => {
  const exact = compileRule(rule({ amount_min_cents: 850000, amount_max_cents: 850000, currency: "SEK", direction: "out" }));
  assert.equal(ruleMatches(exact, row({ amount_cents: 850000 })), "match");
  assert.equal(ruleMatches(exact, row({ amount_cents: -850000 })), "match");
  assert.equal(ruleMatches(exact, row({ amount_cents: 849999 })), "no");
  assert.equal(ruleMatches(exact, row({ amount_cents: 850001 })), "no");
  assert.equal(ruleMatches(exact, row({ amount_cents: 850000, currency: "EUR" })), "no");
  const range = compileRule(rule({ amount_min_cents: 100, amount_max_cents: 200, currency: "SEK" }));
  assert.equal(ruleMatches(range, row({ amount_cents: 100 })), "match");
  assert.equal(ruleMatches(range, row({ amount_cents: 200 })), "match");
  assert.equal(ruleMatches(range, row({ amount_cents: 99 })), "no");
  const oneSided = compileRule(rule({ amount_min_cents: 0, currency: "SEK" }));
  assert.equal(ruleMatches(oneSided, row({ amount_cents: 0 })), "match");
  const upTo = compileRule(rule({ amount_max_cents: 0, currency: "SEK" }));
  assert.equal(ruleMatches(upTo, row({ amount_cents: 0 })), "match");
  assert.equal(ruleMatches(upTo, row({ amount_cents: 1 })), "no");
});

test("booking day: inclusive 1-31 day-of-month, no wrap, invalid dates never match", () => {
  const late = compileRule(rule({ ...cp("grocery"), booking_day_from: 25, booking_day_to: 31 }));
  assert.equal(ruleMatches(late, row({ booking_date: "2030-01-25" })), "match");
  assert.equal(ruleMatches(late, row({ booking_date: "2030-01-31" })), "match");
  assert.equal(ruleMatches(late, row({ booking_date: "2030-02-01" })), "no");
  assert.equal(ruleMatches(late, row({ booking_date: "2030-02-30" })), "no"); // not a real date
  assert.equal(ruleMatches(late, row({ booking_date: "garbage" })), "no");
});

test("account scope: a scoped rule matches only its identity; a row without identity matches global rules only", () => {
  const scoped = rule({ ...cp("grocery"), account_identity_id: "b".repeat(32), category_id: "scoped" });
  const global = rule({ ...cp("grocery"), category_id: "global", priority: 1 });
  const rules = new RuleSet([scoped, global]);
  assert.equal(evaluate(row({ account_identity_id: "b".repeat(32) }), rules, null).category_id, "scoped");
  assert.equal(evaluate(row({ account_identity_id: "a".repeat(32) }), rules, null).category_id, "global");
  assert.equal(evaluate(row({ account_identity_id: null }), rules, null).category_id, "global");
});

test("predicates are a conjunction", () => {
  const r = compileRule(rule({ ...cp("landlord", "exact"), direction: "out", amount_min_cents: 850000, amount_max_cents: 850000, currency: "SEK" }));
  assert.equal(ruleMatches(r, row({ counterparty: "Landlord", amount_cents: 850000 })), "match");
  assert.equal(ruleMatches(r, row({ counterparty: "Landlord", amount_cents: 1 })), "no");
  assert.equal(ruleMatches(r, row({ counterparty: "Other", amount_cents: 850000 })), "no");
  assert.equal(ruleMatches(r, row({ counterparty: "Landlord", amount_cents: 850000, credit_debit: "CRDT" })), "no");
});

test("uncertainty: flagged when rules of different categories match or the winner is a short contains", () => {
  const a = rule({ ...cp("grocery"), category_id: "a", priority: 200 });
  const b = rule({ ...cp("example"), category_id: "b" });
  assert.equal(evaluate(row(), new RuleSet([a, b]), null).category_uncertain, true);
  const same = rule({ ...cp("example"), category_id: "a" });
  assert.equal("category_uncertain" in evaluate(row(), new RuleSet([a, same]), null), false);
  const short = rule(cp("gro"));
  assert.equal(evaluate(row(), new RuleSet([short]), null).category_uncertain, true);
  // Manual overrides are never uncertain.
  assert.equal("category_uncertain" in evaluate(row(), new RuleSet([a, b]), override()), false);
});

test("a malformed stored rule fails closed only for rows it could have won; overrides still apply", () => {
  const malformed = [
    { direction: "sideways" },
    { counterparty_mode: "regex", counterparty_pattern: ".*" },
    { counterparty_mode: "contains", counterparty_pattern: "ab" },
    { amount_min_cents: 10 }, // amount without currency
    { amount_min_cents: 10, amount_max_cents: 5, currency: "SEK" },
    { booking_day_from: 10, booking_day_to: null },
    { counterparty_mode: null, counterparty_pattern: null }, // global catch-all
    { counterparty_mode: "exact", counterparty_pattern: "İ".repeat(81) }, // key longer than 160 after lowercasing
  ];
  for (const bad of malformed) {
    const label = JSON.stringify(bad);
    const good = rule({ ...cp("grocery"), category_id: "good", priority: 100 });
    // Ranked above the good rule: the malformed rule might have won, so fail closed.
    const above = new RuleSet([good, rule({ ...cp("zzzz"), priority: 500, ...bad })]);
    assert.equal(above.malformedIds.length, 1, label);
    const out = evaluate(row(), above, null);
    assert.equal(out.category, null, label);
    assert.equal(out.category_rule_id, null, label);
    assert.equal(out.category_warning, "rules_unavailable", label);
    assert.equal(evaluate(row(), above, override()).category_source, "manual", label);
    // Ranked below the winner: it cannot change the outcome, so the good rule applies.
    const below = new RuleSet([good, rule({ ...cp("zzzz"), priority: 10, ...bad })]);
    assert.equal(evaluate(row(), below, null).category_id, "good", label);
    // Scoped to another account: rows elsewhere are unaffected.
    const elsewhere = new RuleSet([good, rule({ ...cp("zzzz"), priority: 500, account_identity_id: "c".repeat(32), ...bad })]);
    assert.equal(evaluate(row(), elsewhere, null).category_id, "good", label);
  }
  // An unreadable priority sorts first: it could have outranked anything.
  const topBad = new RuleSet([rule({ ...cp("grocery"), priority: 1000 }), rule({ ...cp("zzzz"), priority: 5000 })]);
  assert.equal(evaluate(row(), topBad, null).category_warning, "rules_unavailable");
});
