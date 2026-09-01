# Contributing

Thanks for your interest in banking-mcp. It is a self-hosted, read-only bank-data MCP server, so correctness and secret hygiene matter more than features.

## Development

Requirements: Node.js 22+ and npm.

```bash
npm ci
npm run typecheck
npm test
npm run dev        # local Worker at http://127.0.0.1:8787
```

`npm test` runs the suite in `test/`, and `npm run typecheck` runs `tsc --noEmit`. CI runs both plus `npm audit --audit-level=high` and `wrangler deploy --dry-run` on every push and pull request. Keep all of them green.

## Pull requests

- Branch from `main` and keep each PR focused on one change.
- Add or update a test when you change behaviour, especially anything in the auth flow, the MCP tool output, or secret handling.
- Describe what changed and why. Link the issue if there is one.
- Do not bump the deployed version or edit generated files (`worker-configuration.d.ts`) by hand.

## Secret hygiene (please read)

This server handles access to real bank data, so treat every change as security-sensitive.

- Never commit real secrets. `.dev.vars`, `.mcp-credentials`, `wrangler.local.jsonc`, and `*.pem` / `*.key` are git-ignored; keep them that way.
- Never put a token, password, IBAN, account identifier, or personal detail into code, tests, logs, commit messages, or CI output. The operator token must stay out of request URLs.
- MCP tool responses must not carry secrets or upstream session identifiers. If you touch `src/mcp.ts`, `src/mcp-output.ts`, or `src/db.ts`, check that the response still exposes only the whitelisted fields.
- Error responses and logs must not echo upstream payloads or secret material.

## Reporting a vulnerability

Do not open a public issue for a security problem. Follow [SECURITY.md](SECURITY.md) to report it privately.
