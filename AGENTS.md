# Installing banking-mcp

Use this procedure when a user asks you to install this repository as an MCP server.

## Required interaction

1. If the user has not already chosen, ask exactly one question before changing anything: **Cloud, Local, or Both?** Recommend Cloud for Claude.ai, other remote HTTP MCP clients, phones, or several devices. Do not promise Codex Cloud support; its MCP setup is not documented here.
2. Inspect `README.md`, `package.json`, `wrangler.jsonc`, and `scripts/setup.mjs`. Check Node.js is version 22.6 or newer.
3. Install the locked dependencies with `npm ci`. Run `npm audit` and `npm run typecheck`; report a blocker before continuing if either reveals a material security or build failure.
4. Run `npm run install:mcp` with `--cloud`, `--local`, or `--both`. Always pass the flag: without one the installer asks in the terminal, but when there is no TTY it silently chooses Local.
5. Cloudflare authentication is interactive. Check with `npx wrangler whoami`; if needed, run `npx wrangler login` and let the user finish sign-in, verification, CAPTCHA, and two-factor authentication in the browser. Never ask the user to paste a Cloudflare password or session token into chat.
6. For Cloud or Both, allow the installer to deploy the unconfigured shell first. Copy the exact Redirect, Privacy, and Terms URLs printed by the script to the user. They are needed to register a new Enable Banking application. In a non-interactive terminal this first `--cloud` run exits with code 1 and "Missing Application ID" after deploying the shell and printing the URLs. That is the intended pause, not a failure; do not retry or debug it.
7. Pause for exactly these two inputs:
   - Enable Banking Application ID. This is the UUID on the application's page in the Enable Banking Control Panel; the downloaded key file is usually named after it, but the user should copy the ID from the page, not the file name.
   - Local filesystem path to the downloaded PKCS#8 `.pem` private-key file

   Do not ask for bank username, password, BankID data, account numbers, or unrelated personal information. Never print the private key, commit it, or upload it anywhere except as the intended encrypted Worker secret.
8. Resume after the user has registered the Enable Banking application, activated it, and linked the accounts allowed for Restricted access. A new Production application starts inactive; until the user activates it in the Control Panel (Activate by linking accounts), every API call fails with "Internal error". In a non-interactive agent terminal, use `npm run install:mcp -- --cloud --yes --app-id=<id> --key-file=<local-path>` (or the selected mode). The script reads the key file directly; never paste its contents into the command or chat.
9. To connect a bank, have the user run `npm run auth:link -- --bank=<ASPSP name> --country=<ISO code>` on the operator machine, adding `--psu=business` for company accounts. Always include `--country`: some providers, such as PayPal, are listed once per country, and without it the server may pick the wrong one and the session ends with zero accounts. The printed link carries the operator token (`START_TOKEN`) in its fragment: never print, quote, or paste it into chat. The user opens it and completes bank authorization in the bank's own browser flow. The bank must already be linked to the application under Enable Banking Restricted access, or the result page is "Connected, but no accounts".
10. Configure the requesting MCP client only if the user asked you to do so. Use `MCP_URL` and `CONNECTION_PASSWORD` from `.mcp-credentials` (the installer prints only the file path, never the values); do not commit either.

## Remote or cloud agents

If you run in a hosted sandbox rather than on the user's own computer, the operator cannot open the files you create. `install:mcp` writes the MCP URL and connection password to `.mcp-credentials` and prints only its path, which the user cannot reach from your sandbox. Do not resolve this by pasting the connection password, bank link, or any token into chat.

The safe path is for the user to run `install:mcp` and `auth:link` themselves on their own machine, or in a terminal whose output they can read, and to copy the connection password from there into their MCP client. If you cannot deliver the connection details without exposing them, say so plainly and stop, rather than leaking them.

The recovery path: the user clones the repository on their own machine and runs `npm run install:mcp -- --cloud --app-id=<id> --key-file=<path>`. Because `.dev.vars` does not exist there, the installer generates a fresh connection password and operator token and overwrites the Worker secrets; anything produced in the sandbox becomes invalid, which is intended. The user then runs `auth:link` locally.

## Verification

- Run `npm run typecheck` and `npx wrangler deploy --dry-run`.
- Cloud: confirm `/` returns 200, `/privacy` and `/terms` return 200, and `/setup` returns 404. Never expect a browser setup form.
- Before credentials are installed, `/mcp` should return 503 "Not configured". After installation, verify an MCP `initialize` request succeeds with the generated bearer credential without exposing it in logs.
- Confirm an unauthenticated GET `/auth/start` returns 200 with the "Connect a bank" gate page and no bank list. The "No bank specified" page appears only after the operator link has been opened in a browser, which exchanges the fragment token for a cookie. There is no in-app bank picker: the operator names the bank with `auth:link --bank`, and the user completes bank approval. A session that authorizes but returns no accounts shows "Connected, but no accounts": the account is not linked under Restricted access, or the wrong country was used.
- The real proof of a working install is a `list_accounts` call that returns at least one account. Approving the connector only proves the connection password.

## Safety boundaries

- Make no destructive changes and do not rewrite Git history.
- Do not manually edit, display, or commit `.dev.vars`, `.mcp-credentials`, `.pem`, `.key`, or generated credentials. The installer may create or update them as part of the selected mode.
- Treat `.mcp-credentials`, `CONNECTION_PASSWORD`, the `auth:link` output, `MCP_SECRET`, and `START_TOKEN` as secrets. Never reproduce their values, or URLs containing them, in chat, logs, issues, commits, or pull requests.
- Use Cloudflare Worker secrets for cloud credentials. Do not store application secrets in D1.
- This server is account-information only. Do not add bank-side write, transfer, beneficiary, or payment functionality as part of installation.
- If access, authentication, credentials, or user approval is missing, stop at that exact point and ask only for what is missing.
