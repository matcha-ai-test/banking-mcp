---
name: banking
description: Query your linked bank accounts via banking-mcp — balances, transactions, cash flow, statement export, live refresh. Use for "what's my balance", "how much did I spend on X", "recent transactions", "export my statement", or reconciling accounts.
user-invocable: true
---

# banking-mcp usage

Read-mostly access to your linked bank accounts via Enable Banking. Availability depends on the bank,
country, account type, and your application's access. Installation,
credentials, and MCP registration are in [AGENTS.md](../../AGENTS.md); this skill is for day-to-day use.
The server also supplies MCP instructions. How these and deferred tools are exposed depends on your client.

Terminology: the **authorizer** is the trusted machine that holds the app credentials and runs the bank
link-generation command (`npm run auth:link`). The operator opens that link in a browser and completes bank consent; the browser can be on another device.

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
- **Unclear transaction:** `get_transaction_details` before broader merchant research. Cached details are free; an uncached lookup consumes live-request budget.
- **Session health:** `get_auth_status` for cached status; request `verify: true` when live verification is needed, subject to its cooldown.
- **Categories:** rows from `get_transactions` / `export_statements` carry `category` and `category_source`; `spending_summary` with `group_by: "category"` totals them. To teach a category, suggest it in prose, run `preview_rule`, and only after the user confirms call `create_category` then `add_rule` (or `categorize_transaction` for a single row, using its `account_ref` and `transaction_key`). All of this is local to the server; nothing is written to the bank.

## Cache and live requests

All tools are read-only toward the bank. Live operations can update the server's own cache and accounting state.
- `refresh_now` and uncached `get_transaction_details` share a server-enforced budget of 2/session/UTC day. This is an application policy, not a documented bank limit. Scheduled sync and enrichment have separate controls. Never use `refresh_now` to test connectivity; use `get_auth_status` with `verify: true` if a live check is required.
- `refresh_now`'s enrichment of own-name transfers is configurable, not fixed: `enrichment_backfill_days`
  and `enrichment_max` accept overrides (45 days / 3 per account / 6 per bank session are conservative
  starting recommendations and runtime fallback values, not bank-documented limits). `enrichment_max` overrides both caps with the same value. `enrichment_dry_run: true`
  previews the candidate count from the cache for free before spending live budget.

## Auth & multi-bank
- Sessions renew through the bank's authentication and consent flow, using a link generated on the **authorizer**
  (`npm run auth:link`). No MCP tool can renew a session. If `get_auth_status` shows expired/renewal_due,
  ask the authorizer to run the link — don't retry blindly.
- Add any bank Enable Banking supports: whitelist its accounts in the Enable Banking Control Panel, then
  `npm run auth:link -- --bank=<ASPSP name> --country=<ISO code>` on the authorizer. Always pass
  `--country` (some providers are listed per country).
- If one client fails, check its connector authorization and the server's cached auth status before trusting data. Do not assume a one-client limit or start bank reauthorization solely because another client connected.
