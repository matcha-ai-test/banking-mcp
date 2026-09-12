import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { Db } from "./db";
import { EbClient } from "./eb";
import { readAuthStatus } from "./auth-status";
import { buildStatementExport } from "./export";
import { migrate } from "./migrate";
import {
  AUTH_LINK_CMD,
  buildAuthStatus,
  buildSessionWarnings,
  REFRESH_BUDGET_PER_DAY,
  serializeMcpText,
} from "./mcp-output";
import { syncAll } from "./sync";
import type { Env } from "./types";
import { maskIban, matchAccountUids } from "./util";

/** Guides clients through cached reads, budgeted refreshes, and operator-controlled renewal. */
const SERVER_INSTRUCTIONS = `banking-mcp is a read-only mirror of the operator's bank accounts (Enable Banking, PSD2). Tools read a local cache filled by a nightly sync unless a live call is explicitly requested. Nothing here moves money or writes to a bank.

Normal order: list_accounts to resolve accounts, then get_balances or get_transactions, then export_statements for bulk history. Account uids change after every re-authorization: always match on account name or IBAN, never on a hardcoded uid.

refresh_now fetches transactions and balances from the bank. It is budgeted: 3 per bank per UTC day, because banks allow roughly 4 unattended fetches a day and the nightly sync reserves one. A failed attempt can still consume budget. Never call refresh_now to test connectivity.

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
          balances: balances
            .filter((b) => b.account_uid === a.account_uid)
            .map((b) => ({ type: b.balance_type, amount: money(b.amount_cents), currency: b.currency, as_of: b.fetched_at })),
          last_synced_at: a.last_synced_at,
        }));
        return this.text(warning, out);
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
        },
      },
      async ({ account, date_from, date_to, search, limit, include_pending }) => {
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
        return this.text(warning, {
          booked: booked.map((r) => mapRow(r)),
          ...(include_pending ? { pending } : {}),
          note: "Amounts are signed: negative = money out, positive = money in. Cached data: see last_synced_at via list_accounts.",
        });
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
          "Fetch fresh bank data via Enable Banking and update the local cache; this fetches transactions and balances. Use only when fresh data is needed, never as a connectivity test. Budget: 3 per bank per UTC day; a failed attempt can still count. Supports an optional account filter.",
        inputSchema: {
          account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts."),
          strategy: z.enum(["default", "longest"]).optional().describe('"longest" asks the bank for the deepest available history (use once after a re-authorization for backfill); omit for normal refreshes.'),
        },
      },
      async ({ account, strategy }) => {
        const db = this.db();
        const uids = await this.resolveAccountUids(db, account);
        if (uids !== null && uids.length === 0) return this.text("", { error: `No account matches "${account}"` });

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

          const count = s.refresh_count_date === today ? s.refresh_count_today : 0;
          if (count >= REFRESH_BUDGET_PER_DAY) {
            results.push({
              session: `${s.aspsp_name}/${s.psu_type}`,
              skipped: `Daily refresh budget (${REFRESH_BUDGET_PER_DAY}) used; serving cached data. Budget resets at midnight UTC.`,
            });
            continue;
          }
          await db.bumpRefreshCount(s.id, count + 1, today);
          const summary = await syncAll(this.cfg, "refresh_now", { sessionPk: s.id, accountUids: sessionUids, strategy });
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
            budget_left_today: REFRESH_BUDGET_PER_DAY - count - 1,
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
