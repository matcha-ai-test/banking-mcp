# banking-mcp

[![CI](https://github.com/matcha-ai-test/banking-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/matcha-ai-test/banking-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Private, read-only bank access for [Claude](https://claude.ai) and [Codex](https://openai.com/codex/), powered by [Enable Banking](https://enablebanking.com). It reads balances and transaction history from accounts you approve. **It has no bank-side write capability:** it cannot create, change, or delete bank data, move money, or initiate payments. It writes only to its own private cache.

## Requirements

- Node.js 22.15 or newer (the tests use `node:sqlite`, `--experimental-strip-types`, and `node:module` hooks) and npm.
- A Cloudflare account with a registered `workers.dev` subdomain. New accounts do not have one; set it under **Workers & Pages** in the Cloudflare dashboard first, otherwise the deploy succeeds but no public URL exists. Not needed for Local mode.
- An Enable Banking account with access to the [Control Panel](https://enablebanking.com/cp/applications).
- A bank on Enable Banking's [supported list](https://enablebanking.com/docs/markets).
- `openssl`, only if your Enable Banking key is PKCS#1 (starts with `-----BEGIN RSA PRIVATE KEY-----`) and needs converting.

## Quick start

There are three ways in. Each one stops at the same place: you register the Enable Banking application yourself, then connect a bank with `auth:link`.

| Path | What you need | What it does | What it does not do |
|---|---|---|---|
| **Deploy button** | GitHub and Cloudflare accounts | Clones the repository into your GitHub account, provisions D1, KV, and the Durable Object, deploys an unconfigured Worker | Does not register Enable Banking, set secrets, or connect a bank. You still clone locally and run `npm run install:mcp -- --cloud` |
| **AI agent** | Codex, Claude Code, or another coding agent with a terminal | Runs the installer for you, following [AGENTS.md](AGENTS.md), and pauses when it needs your Application ID and key file | Cannot open the Enable Banking Control Panel or approve at your bank for you. Never give it bank credentials |
| **Manual** | A terminal | You run `npm ci` and `npm run install:mcp` yourself and follow the printed steps | Nothing is done for you, which is also the easiest path to debug |

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matcha-ai-test/banking-mcp)

One click clones this repository into your own GitHub account, provisions the D1 database, KV namespace, and Durable Object, and deploys the Worker with Workers Builds CI. The deploy runs into **your** Cloudflare account with **your** own Enable Banking application; no data flows to anyone else.

It does **not** finish configuration. The Worker needs its deployed URL before you can register the Enable Banking application, so secrets are set afterwards, not on the deploy page. Until they are, `/mcp` returns `503 Not configured` and the bank endpoints stay closed. After the deploy finishes, clone your new repository locally and run `npm run install:mcp -- --cloud` to register the application and set the secrets. Then follow [Set up Enable Banking](#set-up-enable-banking) and [Connect a bank](#connect-a-bank).

Prefer to provision everything from the command line instead? Skip the button and follow [Install manually](#install-manually).

## Install with an AI agent

Give this repository URL to Codex, Claude Code, or another coding agent and say:

```text
Install this repository as an MCP server. Follow AGENTS.md. Ask me whether I
want Cloud, Local, or Both before making changes. Never ask for bank login
credentials, and stop when you need my Enable Banking Application ID and the
local path to its downloaded .pem private-key file.
```

The agent procedure is in [AGENTS.md](AGENTS.md). There is deliberately **no browser setup page**. Installation, secrets, deployment, and verification are handled from the cloned repository.

## Install manually

See [Requirements](#requirements) first.

```bash
git clone https://github.com/matcha-ai-test/banking-mcp.git
cd banking-mcp
npm ci
npm run install:mcp
```

The installer asks first:

| Mode | Use it for |
|---|---|
| **Cloud** | Claude.ai and other remote MCP clients, phone, or several devices. Recommended. |
| **Local** | Claude Code or Codex on one computer. |
| **Both** | Local and cloud clients sharing the cloud database. |

Explicit commands are also available:

```bash
npm run install:mcp -- --cloud
npm run install:mcp -- --local
npm run install:mcp -- --both
```

Without a flag the installer asks in the terminal, but when there is no TTY (an agent, a CI job, a piped shell) it silently chooses Local. Agents should always pass a flag.

The installer stores the MCP URL and connection password (`MCP_SECRET`) in Git-ignored `.mcp-credentials` with mode `0600`; for these client values the terminal prints only the file path. The operator token (`START_TOKEN`) is not written there; it stays in `.dev.vars`, and `npm run auth:link` reads it to print a bank link on demand. See [Connect a bank](#connect-a-bank).

Cloud setup keeps the tracked `wrangler.jsonc` template unchanged by writing discovered deployment values to Git-ignored `wrangler.local.jsonc`; `npm run dev` and `npm run deploy` select that local config automatically when it exists.

For a non-interactive agent resuming after Enable Banking registration:

```bash
npm run install:mcp -- --cloud --yes --app-id=<id> --key-file="/path/to/key.pem"
```

## Set up Enable Banking

This is the Cloud and Both flow. Each step names who does it.

1. **Installer:** opens Cloudflare sign-in if needed and deploys an unconfigured Worker to obtain its final URL.
2. **Installer:** prints the exact Redirect, Privacy, and Terms URLs required by Enable Banking, then stops and asks for the Application ID and key file. In a non-interactive terminal this first run exits with code 1 and "Missing Application ID" after printing the URLs. That is the intended pause, not a failure.
3. **You, in the Control Panel:** create the application at [Enable Banking API applications](https://enablebanking.com/cp/applications):
   - Choose **Production** for real accounts; Sandbox is test data only.
   - Choose **Generate in the browser** and export the private key.
   - Paste the Redirect, Privacy, and Terms URLs the installer printed.

   Linking accounts in Enable Banking only restricts which accounts the application may access. The later bank authorization in [Connect a bank](#connect-a-bank) is a separate step that creates an active API session.
4. **You, in the Control Panel:** activate the application. A new Production application starts inactive and every API call fails with "Internal error" until it is activated. In the Control Panel open the application, choose **Activate by linking accounts**, and link the bank accounts banking-mcp may read. This is what makes it Restricted: it can only see the accounts you link here.
5. **You, in the terminal:** return with only the Application ID and the local path to the downloaded `.pem` file, and run the installer again (see the non-interactive command above, or rerun `npm run install:mcp -- --cloud` and answer the prompts). The installer stores them as encrypted Cloudflare Worker secrets and deploys the configured server.

   The Application ID is the UUID on the application's page in the Control Panel; the downloaded key file is usually named after it, but copy the ID from the page, not the file name.
6. **You, in the terminal:** connect a bank. See [Connect a bank](#connect-a-bank).
7. **You, in your MCP client:** connect using `MCP_URL` and `CONNECTION_PASSWORD` from `.mcp-credentials`. See [Connecting a client](#connecting-a-client).

The `.pem` file is the Enable Banking application's private RSA key, used to sign API calls. It is not a bank login credential. Keep it secret and never commit it. It normally begins with `-----BEGIN PRIVATE KEY-----`. If it begins with `-----BEGIN RSA PRIVATE KEY-----`, convert a copy to PKCS#8:

```bash
openssl pkcs8 -topk8 -nocrypt -in your-key.pem -out key-pkcs8.pem
```

## Connect a bank

On the operator machine (the one holding `.dev.vars`), run:

```bash
npm run auth:link -- --bank=<ASPSP name> --country=<ISO code>
```

Add `--psu=business` for company accounts. The bank name must match Enable Banking's ASPSP name exactly, as shown in the Control Panel or on the [markets page](https://enablebanking.com/docs/markets). Always pass `--country`: some providers (PayPal, for example) are listed once per country, and without `--country` the server takes the first match, which can leave the session with zero accounts. If the name matches in several countries and `--country` is missing, the server answers with a "Bank exists in several countries" page that lists them.

The command prints a link that carries the operator token in its URL fragment. Open it in a browser on any device, approve at your bank, and wait for the result page:

- **Connected:** the session is active, accounts and history were pulled. You can close the tab.
- **Connected, but no accounts:** the bank authorized, but Enable Banking returned no accounts. Either the account is not linked to the application under Restricted access, or the bank was chosen for the wrong country. Fix that in the Control Panel or rerun `auth:link` with the right `--country`.

The bank must already be linked to the application under Restricted access before you connect it here; linking is the step that permits access, this step creates the session.

You can connect several banks by running `auth:link` once per bank. Connecting the same bank again replaces its existing session, which is also how you renew an expiring consent.

## Local mode

After installation, keep the server running:

```bash
npm start
```

The MCP endpoint is `http://127.0.0.1:8787/mcp`. Cloud clients cannot reach a local address. The bank-link cookie is set with `Secure` only over https, so the `auth:link` flow works over `http://127.0.0.1` as well.

For Local-only installs, register the Enable Banking application with these URLs:

- Redirect: `http://127.0.0.1:8787/auth/callback`
- Privacy: `http://127.0.0.1:8787/privacy`
- Terms: `http://127.0.0.1:8787/terms`

It is not verified that Enable Banking accepts an http loopback address on a Production application. If the Control Panel rejects these URLs, register the application through Cloud mode or `--both` instead, which gives it a public https URL.

## Connecting a client

Take `MCP_URL` and `CONNECTION_PASSWORD` from `.mcp-credentials`. Never commit either value or paste it into a shared file.

### Claude (remote connector)

Add the `/mcp` URL as a custom connector. The server runs its own OAuth flow and opens an approval page; enter `CONNECTION_PASSWORD` there.

Approving the connector only proves the connection password. Ask Claude to call `list_accounts`: the connection is complete when it returns at least one account. An empty list means no bank session exists yet or the session returned no accounts.

### Codex CLI

Keep the password in an environment variable rather than in `~/.codex/config.toml`. Reading it interactively avoids leaving it in your shell history:

```bash
read -s BANKING_MCP_TOKEN
export BANKING_MCP_TOKEN
```

Then register the server:

```bash
codex mcp add banking --url "<MCP_URL>" --bearer-token-env-var BANKING_MCP_TOKEN
```

The variable must be set whenever Codex starts. Verify with `codex mcp get banking --json`, then ask Codex to call `list_accounts`: a successful tool call is the real proof, the config check only shows what was saved.

### Codex Cloud

Not documented yet. The CLI configuration above does not by itself configure a cloud task, so do not copy it into a cloud environment before checking the current official Codex documentation for MCP and secret handling there.

## Tools

| Tool | Purpose |
|---|---|
| `list_accounts` | Cached accounts, masked IBANs, latest cached balances, and last sync time |
| `get_balances` | Cached balances, optionally filtered by account name, last four IBAN digits, or bank |
| `get_transactions` | Up to 500 cached transactions, pending included by default, with account, date, and text filters |
| `refresh_now` | Live refresh from the bank, limited to 3 per bank session per UTC day and shared across all connected clients. Adds a `hint` field when a session syncs zero accounts |
| `get_auth_status` | Cached session metadata plus the result of the most recent verified bank call. Does not call the bank and returns no token or secret link |
| `export_statements` | Bulk JSON export of cached booked transactions since a date, default `2025-01-01`, with a running balance per row. Can be filtered by bank and by account |

Bank availability is loaded live from Enable Banking. Its documentation covers country-specific Open Banking support across [EU/EEA markets](https://enablebanking.com/docs/markets); available countries, banks, and Personal/Business support can change.

## How it works

The Worker holds one Enable Banking session per connected bank and caches accounts, balances, and transactions in its own D1 database. Tool calls read from that cache; they never hit the bank directly.

- A cron job syncs every active session at 04:00 UTC.
- `refresh_now` allows 3 extra live fetches per bank per UTC day on top of the nightly sync. Banks typically permit about four unattended fetches a day.
- The first connection backfills history, trying up to 5 years and falling back to shorter windows if the bank refuses.
- A bank consent lasts at most 180 days. Every tool response carries a warning from 14 days before expiry, and the operator renews by running `auth:link` for that bank again.
- Full upstream payloads are not stored; only the fields the tools return are cached.

## Example tasks

- "List my connected accounts and total balance per currency. Keep IBANs masked."
- "Refresh once if allowed, then summarize the last seven days and largest expenses."
- "Compare this month's spending with last month and mark uncertain categories."
- "Find likely subscriptions and recurring charges from the last three months."
- "Check which bank session expires first and tell me how the operator renews it."

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Internal error" when opening the bank link | The Enable Banking application is not activated, or the Application ID or key is wrong | Activate the application in the Control Panel (Activate by linking accounts), then check the Application ID and `.pem` and rerun `install:mcp` |
| "Connected, but no accounts" | The account is not linked to the application under Restricted access, or the bank was chosen for the wrong country | Link the account in the Control Panel, then rerun `auth:link` with `--country` |
| `503 Not configured` on `/mcp` | Secrets are missing on the Worker | Run `npm run install:mcp -- --cloud` from the cloned repository |
| "Deploy succeeded but no workers.dev URL was printed" | New Cloudflare account without a `workers.dev` subdomain | Register the subdomain under Workers & Pages in the dashboard and rerun |
| "Unknown bank" page | The name does not match Enable Banking's ASPSP name, or `--country` is missing | Copy the exact ASPSP name from the Control Panel and pass `--country` |
| "Bank exists in several countries" page | The name matches in more than one country | Rerun `auth:link` with `--country=<ISO code>` |
| Connector approved but `list_accounts` is empty | No bank session exists yet | Run `auth:link` and complete the bank approval |
| "session expires in N days" in tool responses | The bank consent is about to expire | Run `auth:link` for that bank again; the new session replaces the old one |

## Security

- No bank-side write tools, transfers, or payments exist in this server.
- `/mcp` requires the generated connection password (`MCP_SECRET`).
- `/auth/start` requires the operator token (`START_TOKEN`), carried in the link fragment and exchanged for a short-lived cookie.
- A Restricted Enable Banking application can access only accounts linked to it.
- Local secrets are stored in Git-ignored `.dev.vars`; cloud secrets are uploaded as encrypted Cloudflare Worker secrets. With `--both`, the same secrets are also written to the local `.dev.vars`.
- `.dev.vars`, `.mcp-credentials`, `wrangler.local.jsonc`, `.pem`, and `.key` files are excluded from Git.
- Full upstream transaction payloads are not retained; only fields used by the tools are cached.
- Bank approval occurs at the bank. The server never asks for or stores your bank login credentials.

To rotate the connection password or operator token: remove `MCP_SECRET` and/or `START_TOKEN` from `.dev.vars`, run `npm run install:mcp` again with the same mode flag, and reconnect your clients with the new password. To rotate the Enable Banking key: generate a new key for the application in the Control Panel and run the installer again with the new `.pem` file.

## Uninstall

1. Delete the Worker: `npx wrangler delete` from the repository.
2. Delete the D1 database and the KV namespace in the Cloudflare dashboard. The Durable Object storage goes away with the Worker.
3. Revoke or delete the application in the Enable Banking Control Panel.
4. Revoke the bank consent at your bank, in its own consent or third-party access settings.
5. Delete `.dev.vars`, `.mcp-credentials`, and `wrangler.local.jsonc` locally, and the downloaded `.pem` file if you no longer need it.

## Cost

For a single operator, Cloudflare's free tier is normally enough for Workers, D1, KV, and SQLite-backed Durable Objects; check the current limits on Cloudflare's pricing pages if you connect many banks. For Enable Banking, check their current pricing. Restricted access to your own accounts has been free of charge, but verify that before you rely on it.

## Official references

- [Enable Banking: application registration](https://enablebanking.com/docs/api/control-panel/)
- [Enable Banking: Restricted access and linked accounts](https://enablebanking.com/docs/api/linked-accounts)
- [Enable Banking: API quick start](https://enablebanking.com/docs/api/quick-start/)
- [Cloudflare Workers: Wrangler](https://developers.cloudflare.com/workers/wrangler/)

## Contributing

Bug reports, security reports, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for how to report a vulnerability privately.

## License

MIT. See [LICENSE](LICENSE).
