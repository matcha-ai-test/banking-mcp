# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub's private vulnerability reporting**: open the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue for security problems.

You can expect an acknowledgement within 7 days. Please include steps to reproduce, the affected component (Worker endpoint, MCP tool, installer script), and impact.

## Scope

This server is account-information only (Enable Banking AIS). It has no bank-side write capability by design. Reports we care most about:

- Authentication bypass of `/mcp` (connection password, `MCP_SECRET`) or `/auth/start` (operator token, `START_TOKEN`)
- Leakage of cached bank data, secrets, or the Enable Banking private key
- Injection or privilege escalation through MCP tool inputs
- Supply-chain issues in dependencies or the installer (`scripts/setup.mjs`)

Out of scope: vulnerabilities in Enable Banking, Cloudflare, or your bank's own services. Report those upstream.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches.

## Handling of secrets

`.dev.vars`, `.mcp-credentials`, `wrangler.local.jsonc`, `*.pem`, and `*.key` are Git-ignored and must never be committed. In Cloud mode, secrets are uploaded as encrypted Cloudflare Worker secrets; the installer also keeps a copy in the local `.dev.vars` on the operator machine, and with `--both` the same secrets are used by the local server as well. `.mcp-credentials` holds the MCP URL and the connection password for your client; the operator token lives only in `.dev.vars`.

If you believe a secret has been exposed, rotate it immediately and report the exposure path:

- Connection password or operator token: remove `MCP_SECRET` and/or `START_TOKEN` from `.dev.vars`, run `npm run install:mcp` again with the same mode flag, and reconnect your clients with the new password. Any previously printed bank link stops working.
- Enable Banking key: generate a new key for the application in the Enable Banking Control Panel and run the installer again with the new `.pem` file.
