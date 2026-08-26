# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub's private vulnerability reporting**: open the repository's **Security** tab → **Report a vulnerability**. Do not open a public issue for security problems.

You can expect an acknowledgement within 7 days. Please include steps to reproduce, the affected component (Worker endpoint, MCP tool, installer script), and impact.

## Scope

This server is account-information only (Enable Banking AIS). It has no bank-side write capability by design. Reports we care most about:

- Authentication bypass of `/mcp` (connection password) or `/auth/start` (link token)
- Leakage of cached bank data, secrets, or the Enable Banking private key
- Injection or privilege escalation through MCP tool inputs
- Supply-chain issues in dependencies or the installer (`scripts/setup.mjs`)

Out of scope: vulnerabilities in Enable Banking, Cloudflare, or your bank's own services — report those upstream.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches.

## Handling of secrets

`.dev.vars`, `*.pem`, and `*.key` are Git-ignored and must never be committed. Cloud secrets live only as encrypted Cloudflare Worker secrets. If you believe a secret has been exposed, rotate it immediately (Enable Banking application key, `MCP_SECRET`, `START_TOKEN`) and report the exposure path.
