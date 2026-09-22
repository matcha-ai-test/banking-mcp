import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { Db } from "./db";
import { EbClient } from "./eb";
import { readAuthStatus } from "./auth-status";
import { readTransactionDetails } from "./transaction-details";
import { buildStatementExport } from "./export";
import { migrate } from "./migrate";
import {
  AUTH_LINK_CMD,
  buildAuthStatus,
  buildSessionWarnings,
  compactJson,
  REFRESH_BUDGET_PER_DAY,
  serializeMcpText,
} from "./mcp-output";
import { previewEnrichmentCandidates, syncAll } from "./sync";
import type { Env } from "./types";
import { maskIban, matchAccountUids } from "./util";

/** Guides clients through cached reads, budgeted refreshes, and operator-controlled renewal. */
const SERVER_INSTRUCTIONS = `banking-mcp is a read-only mirror of the operator's bank accounts (Enable Banking, PSD2). Tools read a local cache filled by a nightly sync unless a live call is explicitly requested. Nothing here moves money or writes to a bank.

Normal order: list_accounts to resolve accounts, then get_balances or get_transactions, then export_statements for bulk history. Account uids change after every re-authorization: always match on account name or IBAN, never on a hardcoded uid. For totals and breakdowns use spending_summary, which sums in the database, rather than adding up transaction rows yourself. list_banks answers which banks Enable Banking supports from a local cache.

Rows whose bank text is only the account holder's own name are automatically enriched from the bank's detail record during sync (capped per night); get_transaction_details returns the cached detail for free and only calls the bank when no detail is cached yet (one bank fetch from the daily budget). Enrichment's backfill window and per-account/per-session caps are configurable, both per refresh_now call and, for the nightly sync, via optional Worker vars — the built-in figures (45 days, 3 per account, 6 per bank session) are conservative starting recommendations, not fixed defaults or documented bank limits. Preview a run with refresh_now's enrichment_dry_run before spending live budget.

refresh_now fetches transactions and balances from the bank. It is budgeted: 3 per bank session per UTC day, because banks allow roughly 4 unattended fetches a day and the nightly sync reserves one. A failed attempt can still consume budget. Never call refresh_now to test connectivity.

get_auth_status returns cached session metadata plus the last verified live call by default. Set verify=true to check stored sessions via Enable Banking, with a 15-minute server-side cooldown; live_cached=true means the stored verification result was reused. Verification does not refresh account data; its upstream budget cost is undocumented. Cached status can read active while the bank session has in fact expired; last_live_* is the authority. Use get_auth_status, not refresh_now, to check whether the connection is healthy.

Bank consent lasts at most 180 days and only the operator can renew it from their own machine. If a tool reports an expired session, tell the user; do not attempt re-authorization.`;

function money(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function signed(cents: number, creditDebit: string): number {
  return money(creditDebit === "DBIT" ? -Math.abs(cents) : Math.abs(cents));
}

export class BankingMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: "banking-mcp", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  /** Worker bindings and encrypted secrets supplied by Wrangler. */
  private cfg!: Env;

  private db(): Db {
    return new Db(this.cfg);
  }

  /** Renewal warning prefixed to every tool response when a session is close to expiry. */
  private async warnings(db: Db): Promise<string> {
    const sessions = await db.sessionsNeedingWarning();
    return buildSessionWarnings(sessions);
  }

  /** See matchAccountUids in util.ts; skips the query when no filter was given. */
  private async resolveAccountUids(db: Db, account?: string): Promise<string[] | null> {
    if (!(account ?? "").trim()) return null;
    return matchAccountUids(await db.allAccountsWithBank(), account);
  }

  private text(warning: string, data: unknown) {
    return serializeMcpText(warning, data);
  }

  async init() {
    await migrate(this.env.DB);
    this.cfg = this.env;

    this.server.registerTool(
      "list_accounts",
      {
        description:
          "List linked accounts, latest known balances, and last sync time from the local cache. Use first to resolve account names and IBANs because uids rotate after re-authorization. No bank call or refresh-budget cost.",
        inputSchema: {},
      },
      async () => {
        const db = this.db();
        const [accounts, balances, warning] = await Promise.all([db.allAccountsWithBank(), db.balances(), this.warnings(db)]);
        const out = accounts.map((a) => ({
          account_uid: a.account_uid,
          bank: a.aspsp_name,
          name: a.name,
          iban: maskIban(a.iban),
          currency: a.currency,
          psu_type: a.psu_type,
          // Session-response metadata; compactJson drops the fields a bank did not supply.
          account_type: a.cash_account_type ?? null,
          usage: a.usage ?? null,
          bic: a.bic ?? null,
          card_last4: a.card_last4 ?? null,
          credit_limit: a.credit_limit_cents != null ? money(a.credit_limit_cents) : null,
          balances: balances
            .filter((b) => b.account_uid === a.account_uid)
            .map((b) => ({ type: b.balance_type, amount: money(b.amount_cents), currency: b.currency, as_of: b.fetched_at })),
          last_synced_at: a.last_synced_at,
        }));
        return this.text(warning, compactJson(out));
      }
    );

    this.server.registerTool(
      "get_balances",
      {
        description:
          "Get latest cached balances for all accounts or matching accounts. Use for balance questions after resolving accounts with list_accounts. The account filter accepts name, IBAN, last-4, uid, or bank name. No bank call or refresh-budget cost.",
        inputSchema: { account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts.") },
      },
      async ({ account }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) return this.text("", { error: `No account matches "${account}"` });
        const rows = await db.balances(uids);
        const warning = await this.warnings(db);
        return this.text(
          warning,
          rows.map((r) => ({
            account: r.name ?? r.account_uid,
            iban: maskIban(r.iban),
            balance_type: r.balance_type,
            amount: money(r.amount_cents),
            currency: r.currency,
            as_of: r.fetched_at,
          }))
        );
      }
    );

    this.server.registerTool(
      "get_transactions",
      {
        description:
          "Get cached booked transactions, newest first, and pending transactions when include_pending is true. Use for interactive transaction questions; supports date range, free-text search, and limit. The account filter accepts name, IBAN, last-4, uid, or bank name. No bank call or refresh-budget cost.",
        inputSchema: {
          account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts."),
          date_from: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
          date_to: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
          search: z.string().optional().describe("Free-text match on counterparty/description"),
          limit: z.number().int().min(1).max(500).default(100),
          include_pending: z.boolean().default(true),
          compact: z.boolean().optional().describe("Drop null and empty fields from each row to save context. Omit for the full row shape."),
        },
      },
      async ({ account, date_from, date_to, search, limit, include_pending, compact }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) return this.text("", { error: `No account matches "${account}"` });

        const accounts = await db.allAccounts();
        const nameOf = (uid: string) => accounts.find((a) => a.account_uid === uid)?.name ?? uid.slice(0, 8);

        const base = { accountUids: uids, dateFrom: date_from, dateTo: date_to, search, limit };
        const booked = await db.queryTransactions({ ...base, table: "transactions" });
        const mapRow = (r: (typeof booked)[number], status?: string) => ({
          account: nameOf(r.account_uid),
          booking_date: r.booking_date,
          amount: signed(r.amount_cents, r.credit_debit),
          currency: r.currency,
          counterparty: r.counterparty,
          description: r.remittance_info,
          ...(status ? { status } : {}),
        });

        let pending: ReturnType<typeof mapRow>[] = [];
        if (include_pending) {
          const p = await db.queryTransactions({ ...base, table: "pending_transactions" });
          pending = p.map((r) => mapRow(r, "PENDING"));
        }
        const warning = await this.warnings(db);
        const payload = {
          booked: booked.map((r) => mapRow(r)),
          ...(include_pending ? { pending } : {}),
          note: "Amounts are signed: negative = money out, positive = money in. Cached data: see last_synced_at via list_accounts.",
        };
        return this.text(warning, compact ? compactJson(payload) : payload);
      }
    );

    this.server.registerTool(
      "spending_summary",
      {
        description:
          "Sum cached booked transactions server-side, grouped per currency and by month, counterparty, or account. Use for totals and breakdowns instead of adding up get_transactions rows; the arithmetic is done in the database. Amounts are absolute: out = money out, in = money in, net = in - out. No bank call or refresh-budget cost.",
        inputSchema: {
          account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts."),
          date_from: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
          date_to: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
          group_by: z.enum(["month", "counterparty", "account", "currency"]).default("month"),
          limit: z.number().int().min(1).max(200).default(24).describe("Max groups returned; counterparty and account groups are ordered by money out."),
        },
      },
      async ({ account, date_from, date_to, group_by, limit }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) return this.text("", { error: `No account matches "${account}"` });
        const accounts = await db.allAccounts();
        const nameOf = (uid: string) => accounts.find((a) => a.account_uid === uid)?.name ?? uid.slice(0, 8);
        const rows = await db.summarizeTransactions({ accountUids: uids, dateFrom: date_from, dateTo: date_to, groupBy: group_by, limit });
        const totals = new Map<string, { currency: string; out: number; in: number; count: number }>();
        for (const r of rows) {
          const t = totals.get(r.currency) ?? { currency: r.currency, out: 0, in: 0, count: 0 };
          t.out += r.out_cents; t.in += r.in_cents; t.count += r.count;
          totals.set(r.currency, t);
        }
        const warning = await this.warnings(db);
        return this.text(warning, compactJson({
          group_by,
          date_from: date_from ?? null,
          date_to: date_to ?? null,
          totals: [...totals.values()].sort((a, b) => b.out - a.out || b.in - a.in)
            .map((t) => ({ currency: t.currency, out: money(t.out), in: money(t.in), net: money(t.in - t.out), count: t.count })),
          groups: rows.map((r) => ({
            [group_by]: group_by === "account" ? nameOf(r.key) : r.key,
            currency: r.currency,
            out: money(r.out_cents),
            in: money(r.in_cents),
            net: money(r.in_cents - r.out_cents),
            count: r.count,
          })),
          note: rows.length >= limit
            ? `Only the first ${limit} groups are shown; totals cover those groups only. Raise limit or narrow the date range for a complete sum.`
            : "Booked transactions only; pending rows are excluded. Totals are computed in the database.",
        }));
      }
    );

    this.server.registerTool(
      "amount_as_work_time",
      {
        description:
          "Express an amount as hours of work, using either an explicit monthly net income or an estimate from cached booked inflows (average of the last months). A reflection aid, not advice. No bank call or refresh-budget cost.",
        inputSchema: {
          amount: z.number().positive().describe("Amount to translate, in the income currency"),
          currency: z.string().length(3).optional().describe("ISO code; defaults to the account's currency when estimating"),
          monthly_net_income: z.number().positive().optional().describe("Explicit monthly net income. Omit to estimate from cached inflows."),
          hours_per_month: z.number().positive().max(744).default(160),
          account: z.string().optional().describe("Account name, IBAN, uid or bank name to base the inflow estimate on. Omit for all accounts."),
          months: z.number().int().min(1).max(24).default(3).describe("Lookback for the inflow estimate"),
        },
      },
      async ({ amount, currency, monthly_net_income, hours_per_month, account, months }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) return this.text("", { error: `No account matches "${account}"` });
        let monthly = monthly_net_income ?? null;
        let basis = "explicit monthly_net_income";
        let cur = currency?.toUpperCase() ?? null;
        if (monthly === null) {
          const to = new Date();
          const from = new Date(to);
          from.setUTCMonth(from.getUTCMonth() - months);
          const inflows = await db.inflowTotals({ accountUids: uids, dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10) });
          const pick = cur ? inflows.find((i) => i.currency === cur) : inflows[0];
          if (!pick || pick.in_cents <= 0) {
            return this.text("", { error: "No cached inflows to estimate income from. Pass monthly_net_income explicitly." });
          }
          cur = pick.currency;
          monthly = money(pick.in_cents) / months;
          basis = `average of all booked inflows over the last ${months} month(s) (${pick.count} credits), which may include transfers, refunds and other non-salary income`;
        }
        const hourly = monthly / hours_per_month;
        const hours = amount / hourly;
        return this.text(await this.warnings(db), compactJson({
          amount,
          currency: cur,
          hours: Number(hours.toFixed(1)),
          work_days: Number((hours / (hours_per_month / 20)).toFixed(1)),
          monthly_net_income: Number(monthly.toFixed(2)),
          hourly_net_income: Number(hourly.toFixed(2)),
          hours_per_month,
          basis,
          note: "A reflection aid computed from cached data, not financial advice.",
        }));
      }
    );

    this.server.registerTool(
      "list_banks",
      {
        description:
          "List banks (ASPSPs) Enable Banking supports, from a local cache refreshed weekly by the nightly sync and on every bank link. Use to find the exact ASPSP name and country for auth:link. Cache-only: no bank call or refresh-budget cost.",
        inputSchema: {
          country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code, e.g. SE"),
          search: z.string().max(80).optional().describe("Case-insensitive substring of the bank name"),
          limit: z.number().int().min(1).max(500).default(100),
        },
      },
      async ({ country, search, limit }) => {
        const db = this.db();
        const [rows, fetchedAt] = await Promise.all([db.queryAspsps({ country, search, limit }), db.aspspCacheFetchedAt()]);
        return this.text(await this.warnings(db), compactJson({
          cached_at: fetchedAt,
          banks: rows.map((r) => ({
            name: r.name,
            country: r.country,
            psu_types: r.psu_types ? r.psu_types.split(",") : null,
            max_consent_days: r.maximum_consent_validity != null ? Math.floor(r.maximum_consent_validity / 86400) : null,
          })),
          note: fetchedAt
            ? rows.length >= limit ? `Only the first ${limit} banks are shown; narrow with country or search.` : null
            : `The bank list is not cached yet. It fills on the next nightly sync or the next '${AUTH_LINK_CMD}' run.`,
        }));
      }
    );

    this.server.registerTool(
      "get_transaction_details",
      {
        description:
          "Return the bank's extended record for one cached transaction. Cached details are free and make no bank call. Otherwise, fetch once from the daily budget and cache the detail for future lookups. Sync automatically enriches unclear bank text within per-account and per-session caps. Banks may return nothing extra.",
        inputSchema: {
          account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts."),
          booking_date: z.iso.date().describe("YYYY-MM-DD booking date of the cached transaction"),
          amount: z.number().describe("Signed amount: negative = money out, positive = money in"),
          transaction_id: z.string().min(1).optional().describe("Pass a candidate transaction_id to resolve an ambiguous match"),
        },
      },
      async ({ account, booking_date, amount, transaction_id }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        const result = await readTransactionDetails(db, () => new EbClient(this.cfg),
          { booking_date, amount, transaction_id }, uids);
        return this.text("", result);
      }
    );

    this.server.registerTool(
      "export_statements",
      {
        description:
          "Bulk JSON export of all cached booked transactions for matching accounts since a date, with computed running balances. Use for bulk history; output is large. Cache-only: no bank call or refresh-budget cost. Not for interactive questions; use get_transactions for those.",
        inputSchema: {
          account: z.string().optional().describe("Account name, IBAN or uid. Omit for all accounts in the bank."),
          bank: z.string().optional().describe("ASPSP name (exact Enable Banking name). Omit for every linked bank."),
          since: z.string().default("2025-01-01").describe("YYYY-MM-DD (inclusive)"),
        },
      },
      async ({ account, bank, since }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) {
          return this.text("", { error: `No account matches "${account}"` });
        }
        const data = await buildStatementExport(this.cfg, { bank, since, accountUids: uids });
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      }
    );

    this.server.registerTool(
      "refresh_now",
      {
        description:
          "Fetch fresh bank data via Enable Banking and update the local cache; this fetches transactions and balances. Use only when fresh data is needed, never as a connectivity test. Budget: 3 per bank session per UTC day; a failed attempt can still count. Supports an optional account filter. Enrichment of own-name transfers during this refresh is configurable via enrichment_backfill_days and enrichment_max (see their descriptions for recommended values, not selected defaults); enrichment_dry_run previews candidate counts for free.",
        inputSchema: {
          account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts."),
          strategy: z.enum(["default", "longest"]).optional().describe('"longest" asks the bank for the deepest available history (use once after a re-authorization for backfill); omit for normal refreshes.'),
          enrichment_backfill_days: z.number().int().min(0).optional().describe(
            "Configurable. How far back (days) to look for existing cached rows still eligible for detail enrichment. Recommended starting point: 45 (conservative), not a selected default — omit to keep the current behavior. 0 disables backfill enrichment for this call; newly fetched rows can still be enrichment candidates."
          ),
          enrichment_max: z.number().int().min(0).optional().describe(
            "Configurable. Overrides both the per-account and per-bank-session enrichment detail-call caps for this call. Recommended starting point: 3 per account / 6 per bank session per run (conservative, unattended-sync recommendations — not documented bank limits) — omit to keep the current caps. 0 disables enrichment detail calls entirely for this call."
          ),
          enrichment_dry_run: z.boolean().optional().describe(
            "Configurable. If true, preview only: inspects the local cache for enrichment candidates honoring enrichment_backfill_days and enrichment_max, and returns a sanitized per-account and total candidate count. Makes zero Enable Banking calls, spends zero refresh/detail budget, and writes nothing; ignores strategy."
          ),
        },
      },
      async ({ account, strategy, enrichment_backfill_days, enrichment_max, enrichment_dry_run }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) return this.text("", { error: `No account matches "${account}"` });

        if (enrichment_dry_run) {
          const allAccounts = await db.allAccounts();
          const scoped = uids === null ? allAccounts : allAccounts.filter((a) => uids.includes(a.account_uid));
          const preview = await previewEnrichmentCandidates(db, scoped,
            { enrichMax: enrichment_max, enrichBackfillDays: enrichment_backfill_days });
          return this.text(await this.warnings(db), { dry_run: true, ...preview });
        }

        // Only present in the syncAll filter when explicitly given, so an omitted call is byte-identical
        // to the pre-existing filter shape.
        const enrichmentOverrides = {
          ...(enrichment_max !== undefined ? { enrichMax: enrichment_max } : {}),
          ...(enrichment_backfill_days !== undefined ? { enrichBackfillDays: enrichment_backfill_days } : {}),
        };

        const today = new Date().toISOString().slice(0, 10);
        const sessions = await db.activeSessions();
        if (sessions.length === 0) {
          return this.text(await this.warnings(db), {
            error: `No active bank session. Ask the operator to run '${AUTH_LINK_CMD}' on the operator machine.`,
          });
        }

        // With an account filter, only the sessions that own a matching account
        // are refreshed; the others keep their daily budget and get no hint.
        const ownedBySession = new Map<string, string[]>();
        if (uids !== null) {
          for (const a of await db.allAccountsWithBank()) {
            if (!uids.includes(a.account_uid)) continue;
            ownedBySession.set(a.session_pk, [...(ownedBySession.get(a.session_pk) ?? []), a.account_uid]);
          }
        }

        const results = [];
        for (const s of sessions) {
          const sessionUids = uids === null ? undefined : (ownedBySession.get(s.id) ?? []);
          if (sessionUids && sessionUids.length === 0) continue;

          // The old read-then-bump could overwrite concurrent detail charges.
          // Both tools must reserve through the same atomic budget update.
          const budget = await db.tryChargeRefreshBudget(s.id, today, REFRESH_BUDGET_PER_DAY);
          if (!budget.charged) {
            results.push({
              session: `${s.aspsp_name}/${s.psu_type}`,
              skipped: `Daily refresh budget (${REFRESH_BUDGET_PER_DAY}) used; serving cached data. Budget resets at midnight UTC.`,
            });
            continue;
          }
          const summary = await syncAll(this.cfg, "refresh_now",
            { sessionPk: s.id, accountUids: sessionUids, strategy, ...enrichmentOverrides });
          // An unfiltered refresh of an active session that owns no accounts is
          // not success: the account is usually not linked to the app in the
          // Enable Banking Control Panel, or the bank was authorized for the
          // wrong country.
          const emptyHint =
            !sessionUids && summary.accounts_synced === 0 && summary.errors.length === 0
              ? {
                  hint: `No accounts synced for this session. Link the account to the application in the Enable Banking Control Panel (Restricted access), or re-authorize with the correct country (PayPal, for example, is per country): '${AUTH_LINK_CMD}'.`,
                }
              : {};
          results.push({
            session: `${s.aspsp_name}/${s.psu_type}`,
            ...summary,
            budget_left_today: REFRESH_BUDGET_PER_DAY - budget.count,
            ...emptyHint,
          });
        }
        return this.text(await this.warnings(db), results);
      }
    );

    this.server.registerTool(
      "get_auth_status",
      {
        description:
          "Read cached session metadata, refresh budget, and the last verified live call. Default verify=false makes no bank call. Set verify=true to check each stored session via Enable Banking; results are cached for 15 minutes (live_cached=true). Verification does not refresh account data; its upstream budget cost is undocumented. Cached status may say active when the bank session is expired; last_live_* is authoritative. Renewal is operator-only, from their own machine.",
        inputSchema: {
          verify: z.boolean().optional().default(false).describe("Verify stored sessions live, subject to a 15-minute cooldown. Omit for cached metadata only."),
        },
      },
      async ({ verify }) => {
        const db = this.db();
        const { sessions, liveResults } = await readAuthStatus(db, () => new EbClient(this.cfg), verify);
        return this.text("", buildAuthStatus(sessions, undefined, liveResults));
      }
    );

  }
}
