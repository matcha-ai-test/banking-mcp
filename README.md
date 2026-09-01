# banking-mcp

[![CI](https://github.com/matcha-ai-test/banking-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/matcha-ai-test/banking-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Private, read-only bank access for [Claude](https://claude.ai) and [Codex](https://openai.com/codex/), powered by [Enable Banking](https://enablebanking.com). It reads balances and transaction history from accounts you approve. **It has no bank-side write capability:** it cannot create, change, or delete bank data, move money, or initiate payments. It writes only to its own private cache.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matcha-ai-test/banking-mcp)

One click clones this repository into your own GitHub account, provisions the D1 database, KV namespace, and Durable Object, and deploys the Worker with Workers Builds CI. The deploy runs into **your** Cloudflare account with **your** own Enable Banking application; no data flows to anyone else.

It does **not** finish configuration. The Worker needs its deployed URL before you can register the Enable Banking application, so secrets are set afterwards, not on the deploy page. Until they are, `/mcp` returns `503 Not configured` and the bank endpoints stay closed. After the deploy finishes, clone your new repository locally and run `npm run install:mcp -- --cloud` to register the application, inject secrets, and link your bank. See [Cloud flow](#cloud-flow).

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

Requirements: Node.js 22+ and npm.

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

Setup stores the MCP URL, connection password, and bank link in Git-ignored `.mcp-credentials` with mode `0600`; for these client values the terminal prints only the file path, and `npm run auth:link` prints a fresh operator link locally when needed.

Cloud setup keeps the tracked `wrangler.jsonc` template unchanged by writing discovered deployment values to Git-ignored `wrangler.local.jsonc`; `npm run dev` and `npm run deploy` select that local config automatically when it exists.

For a non-interactive agent resuming after Enable Banking registration:

```bash
npm run install:mcp -- --cloud --yes --app-id=<id> --key-file="/path/to/key.pem"
```

## Cloud flow

1. The installer opens Cloudflare sign-in if needed and deploys an unconfigured Worker to obtain its final URL.
2. It prints the exact Redirect, Privacy, and Terms URLs required by Enable Banking.
3. Create the application at [Enable Banking API applications](https://enablebanking.com/cp/applications):
   - Choose **Production** for real accounts; Sandbox is test data only.
   - Choose **Generate in the browser** and export the private key.
   - For personal, restricted use, activate by linking your own accounts.
4. Return with only the Application ID and the local path to the downloaded `.pem` file. The installer stores them as encrypted Cloudflare Worker secrets and deploys the configured server.
5. Open `.mcp-credentials` locally and use its bank link. Choose **Personal** for privately owned accounts or **Business** for company-owned accounts, then approve at your bank.
6. Connect your MCP client using `MCP_URL` and `CONNECTION_PASSWORD` from `.mcp-credentials`. See [Connecting a client](#connecting-a-client).

The `.pem` file is the Enable Banking application's private RSA key, used to sign API calls. It is not a bank login credential. Keep it secret and never commit it. It normally begins with `-----BEGIN PRIVATE KEY-----`. If it begins with `-----BEGIN RSA PRIVATE KEY-----`, convert a copy to PKCS#8:

```bash
openssl pkcs8 -topk8 -nocrypt -in your-key.pem -out key-pkcs8.pem
```

Linking accounts in Enable Banking restricts which accounts the application may access. The later bank authorisation is a separate step that creates an active API session.

## Local mode

After installation, keep the server running:

```bash
npm start
```

The MCP endpoint is `http://127.0.0.1:8787/mcp`. Cloud clients cannot reach a local address.

## Connecting a client

Take `MCP_URL` and `CONNECTION_PASSWORD` from `.mcp-credentials`. Never commit either value or paste it into a shared file.

### Claude (remote connector)

Add the `/mcp` URL as a custom connector. The server runs its own OAuth flow and opens an approval page; enter `CONNECTION_PASSWORD` there.

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
| `get_balances` | Cached balances, optionally filtered by account name, masked IBAN, or bank |
| `get_transactions` | Up to 500 cached transactions, pending included by default, with account, date, and text filters |
| `refresh_now` | Live refresh from the bank, limited to 3 per session per UTC day and shared across all connected clients |
| `get_auth_status` | Cached session metadata plus the result of the most recent verified bank call. Does not call the bank and returns no token or secret link |
| `export_statements` | Bulk JSON export of cached booked transactions since a date, default `2025-01-01`, with a running balance per row |

Bank availability is loaded live from Enable Banking. Its documentation covers country-specific Open Banking support across [EU/EEA markets](https://enablebanking.com/docs/markets); available countries, banks, and Personal/Business support can change.

## Example tasks

- “List my connected accounts and total balance per currency. Keep IBANs masked.”
- “Refresh once if allowed, then summarise the last seven days and largest expenses.”
- “Compare this month's spending with last month and mark uncertain categories.”
- “Find likely subscriptions and recurring charges from the last three months.”
- “Check which bank session expires first and tell me how the operator renews it.”

## Security

- No bank-side write tools, transfers, or payments exist in this server.
- `/mcp` requires the generated connection password.
- A Restricted Enable Banking application can access only accounts linked to it.
- Local secrets are stored in Git-ignored `.dev.vars`; cloud secrets are uploaded as encrypted Cloudflare Worker secrets.
- `.dev.vars`, `.mcp-credentials`, `wrangler.local.jsonc`, `.pem`, and `.key` files are excluded from Git.
- Full upstream transaction payloads are not retained; only fields used by the tools are cached.
- Bank approval occurs at the bank. The server never asks for or stores your bank login credentials.

## Official references

- [Enable Banking: application registration](https://enablebanking.com/docs/api/control-panel/)
- [Enable Banking: Restricted access and linked accounts](https://enablebanking.com/docs/api/linked-accounts)
- [Enable Banking: API quick start](https://enablebanking.com/docs/api/quick-start/)
- [Cloudflare Workers: Wrangler](https://developers.cloudflare.com/workers/wrangler/)

## Contributing

Bug reports, security reports, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for how to report a vulnerability privately.

## License

MIT. See [LICENSE](LICENSE).
