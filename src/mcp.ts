import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { Db } from "./db";
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

function money(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function signed(cents: number, creditDebit: string): number {
  return money(creditDebit === "DBIT" ? -Math.abs(cents) : Math.abs(cents));
}

export class BankingMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: "banking-mcp", version: "1.0.0" });
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
          "List all linked bank accounts with their latest known balances and last sync time. Data comes from the local cache (synced nightly + on refresh_now).",
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
          "Get current balances for all accounts, or one account (by name, bank, last four IBAN digits, or uid). Cached data: use refresh_now first if you need up-to-the-minute figures.",
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
          "Get booked transactions from the local cache, newest first. Filter by account (name/IBAN/uid/bank), date range, free-text search and limit. Set include_pending to also return not-yet-booked transactions.",
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
          "Bulk JSON export of ALL cached booked transactions for one account (or one bank) since a date, with a computed running balance per row. Reads only the cache and does not call the bank. Use get_transactions for interactive questions.",
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
          "Fetch fresh data live from the bank (via Enable Banking) and update the cache. Budgeted: max 3 refreshes per session per day (banks typically allow ~4 unattended fetches/day; 1 is reserved for the nightly sync). Optional account filter.",
        inputSchema: { account: z.string().optional().describe("Account name, IBAN, uid or bank name. Omit for all accounts.") },
      },
      async ({ account }) => {
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
          const summary = await syncAll(this.cfg, "refresh_now", { sessionPk: s.id, accountUids: sessionUids });
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
          "Show cached bank session metadata, the most recent verified live-call result, refresh budget, and operator-only renewal instructions.",
        inputSchema: {},
      },
      async () => {
        const db = this.db();
        const sessions = await db.allSessions(10);
        return this.text("", buildAuthStatus(sessions));
      }
    );

  }
}
