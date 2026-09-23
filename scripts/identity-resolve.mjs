#!/usr/bin/env node
// Resolve an account the identity backfill parked as identity_conflict.
//
//   npm run identity:resolve -- --local|--remote list
//   npm run identity:resolve -- --local|--remote attach --account-uid <uid> --identity <account_ref>
//   npm run identity:resolve -- --local|--remote new --account-uid <uid>
//
// Add --dry-run to print the SQL without running it. Operator-only by design:
// it needs wrangler credentials for the account, and no MCP tool can do this.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachSql, listConflictsSql, newIdentityId, newIdentitySql } from "./lib/identity-resolve.mjs";
import { selectWranglerConfig } from "./lib/wrangler-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: npm run identity:resolve -- --local|--remote [--dry-run] list | attach --account-uid <uid> --identity <account_ref> | new --account-uid <uid>");
  process.exit(2);
}

const where = has("--local") ? "--local" : has("--remote") ? "--remote" : null;
if (!where || (has("--local") && has("--remote"))) usage("Choose exactly one of --local or --remote.");
const action = ["list", "attach", "new"].find((a) => args.includes(a));
if (!action) usage("Choose an action: list, attach or new.");

let statements;
try {
  if (action === "list") statements = [listConflictsSql()];
  else if (action === "attach") statements = attachSql(flag("--account-uid"), flag("--identity"));
  else statements = newIdentitySql(flag("--account-uid"), newIdentityId());
} catch (error) {
  usage(error.message);
}

if (has("--dry-run")) {
  for (const sql of statements) console.log(`${sql};\n`);
  process.exit(0);
}

for (const sql of statements) {
  const result = spawnSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "DB", where, "--command", sql, "--config", selectWranglerConfig(root)],
    { cwd: root, stdio: "inherit", env: process.env }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (action !== "list") console.log("Done. Run list_accounts to confirm the account now has an account_ref.");
