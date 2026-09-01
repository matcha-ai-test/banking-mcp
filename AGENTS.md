# Installing banking-mcp

Use this procedure when a user asks you to install this repository as an MCP server.

## Required interaction

1. If the user has not already chosen, ask exactly one question before changing anything: **Cloud, Local, or Both?** Recommend Cloud for Claude.ai, other remote HTTP MCP clients, phones, or several devices. Do not promise Codex Cloud support; its MCP setup is not documented here.
2. Inspect `README.md`, `package.json`, `wrangler.jsonc`, and `scripts/setup.mjs`. Check Node.js is version 22 or newer.
3. Install the locked dependencies with `npm ci`. Run `npm audit` and `npm run typecheck`; report a blocker before continuing if either reveals a material security or build failure.
4. Run `npm run install:mcp` with `--cloud`, `--local`, or `--both`.
5. Cloudflare authentication is interactive. Check with `npx wrangler whoami`; if needed, run `npx wrangler login` and let the user finish sign-in, verification, CAPTCHA, and two-factor authentication in the browser. Never ask the user to paste a Cloudflare password or session token into chat.
6. For Cloud or Both, allow the installer to deploy the unconfigured shell first. Copy the exact Redirect, Privacy, and Terms URLs printed by the script to the user. They are needed to register a new Enable Banking application.
7. Pause for exactly these two inputs:
   - Enable Banking Application ID
   - Local filesystem path to the downloaded PKCS#8 `.pem` private-key file

   Do not ask for bank username, password, BankID data, account numbers, or unrelated personal information. Never print the private key, commit it, or upload it anywhere except as the intended encrypted Worker secret.
8. Resume after the user has registered the Enable Banking application and linked the accounts allowed for Restricted access. In a non-interactive agent terminal, use `npm run install:mcp -- --cloud --yes --app-id=<id> --key-file=<local-path>` (or the selected mode). The script reads the key file directly; never paste its contents into the command or chat.
9. To connect a bank, have the user run `npm run auth:link -- --bank=<ASPSP name>` on the operator machine (add `--psu=business` for company accounts, and `--country=<ISO>` — some providers, such as PayPal, are listed per country). The printed link carries the operator token in its fragment: never print, quote, or paste it into chat. The user opens it and completes bank authorisation in the bank's own browser flow. The bank must already be linked to the application under Enable Banking Restricted access, or the session returns with no accounts.
10. Configure the requesting MCP client only if the user asked you to do so. Use `MCP_URL` and `CONNECTION_PASSWORD` from `.mcp-credentials` (setup prints only the file path, never the values); do not commit either.

## Remote or cloud agents

If you run in a hosted sandbox rather than on the user's own computer, the operator cannot open the files you create. `setup` writes the MCP URL and connection password to `.mcp-credentials` and prints only its path, which the user cannot reach from your sandbox. Do not resolve this by pasting the connection password, bank link, or any token into chat.

The safe path is for the user to run `setup` and `auth:link` themselves on their own machine, or in a terminal whose output they can read, and to copy the connection password from there into their MCP client. If you cannot deliver the connection details without exposing them, say so plainly and stop, rather than leaking them.

## Verification

- Run `npm run typecheck` and `npx wrangler deploy --dry-run`.
- Cloud: confirm `/` returns 200, `/privacy` and `/terms` return 200, and `/setup` returns 404. Never expect a browser setup form.
- Before credentials are installed, `/mcp` should return 503. After installation, verify an MCP `initialize` request succeeds with the generated bearer credential without exposing it in logs.
- Confirm `/auth/start` without a named bank returns a "name the bank" page; there is no in-app provider browser. The operator names the bank with `auth:link --bank`, and the user completes bank approval. A session that authorises but returns no accounts means the account is not linked under Restricted access, or the wrong country was used.

## Safety boundaries

- Make no destructive changes and do not rewrite Git history.
- Do not manually edit, display, or commit `.dev.vars`, `.mcp-credentials`, `.pem`, `.key`, or generated credentials. The installer may create or update them as part of the selected mode.
- Treat `.mcp-credentials`, `CONNECTION_PASSWORD`, the `auth:link` output, `MCP_SECRET`, and `START_TOKEN` as secrets. Never reproduce their values, or URLs containing them, in chat, logs, issues, commits, or pull requests.
- Use Cloudflare Worker secrets for cloud credentials. Do not store application secrets in D1.
- This server is account-information only. Do not add bank-side write, transfer, beneficiary, or payment functionality as part of installation.
- If access, authentication, credentials, or user approval is missing, stop at that exact point and ask only for what is missing.
