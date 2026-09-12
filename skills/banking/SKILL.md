---
name: banking
description: Query your linked bank accounts via banking-mcp — balances, transactions, cash flow, statement export, live refresh. Use for "what's my balance", "how much did I spend on X", "recent transactions", "export my statement", or reconciling accounts.
user-invocable: true
---

# banking-mcp usage

Read-mostly access to your linked bank accounts via Enable Banking — works with **any ASPSP Enable
Banking supports** (thousands of banks across the EEA/UK), not one specific bank. Installation,
credentials, and MCP registration are in [AGENTS.md](../../AGENTS.md); this skill is for day-to-day use.
The server also ships an `instructions` field that auto-loads into context, so you don't need to explore
the tool list.

Terminology: the **authorizer** is the trusted machine that holds the app credentials and runs the bank
login/consent flow (`npm run auth:link`). Only the authorizer can create or renew a bank session.

## Find the tools in one ToolSearch
If the tools are deferred, load exactly what you need in a single call (server name is whatever you
registered it as, e.g. `banking`):
`ToolSearch select:mcp__banking__get_transactions,mcp__banking__get_balances,mcp__banking__get_auth_status`
On claude.ai/desktop the tools sit under the connector's UUID prefix — use the keyword form instead:
`ToolSearch "banking get_transactions get_balances"`.

## Which tool for which job
- **Balance / "how much do I have":** `get_balances` (or `list_accounts` for all accounts + last sync time).
- **Spending / history / "how much did I spend on X":** `get_transactions` (account, date range, free-text
  search, limit; returns booked + pending). Amounts are signed: negative = out, positive = in.
- **Bulk export for external processing:** `export_statements` (all cached booked rows since a date, with a
  running balance; cache-only, no bank call).
- **Fresh figures right now:** `refresh_now` — see budget below.
- **Session health:** `get_auth_status`.

## Read vs write
Everything is read-only **except `refresh_now`**, which spends the daily fetch budget.
- `refresh_now` is budgeted (max 3/session/day; banks allow ~4 unattended fetches/day, 1 reserved for the
  nightly sync). **Never** call it just to test connectivity — use `get_auth_status` for that. Data is
  otherwise served from a local cache synced nightly.

## Auth & multi-bank
- Sessions renew via bank login (BankID or the bank's own flow) on the **authorizer only**
  (`npm run auth:link`). No tool can renew a session. If `get_auth_status` shows expired/renewal_due,
  ask the authorizer to run the link — don't retry blindly.
- Add any bank Enable Banking supports: whitelist its accounts in the Enable Banking Control Panel, then
  `npm run auth:link -- --bank=<ASPSP name> --country=<ISO code>` on the authorizer. Always pass
  `--country` (some providers are listed per country).
- If calls from one client start failing after another client was connected, reconnect that client and
  check `get_auth_status` before trusting data. Whether only one OAuth client can be active at a time is
  an observed pattern, not a documented limit.
