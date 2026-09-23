#!/usr/bin/env node
// Revoke every OAuth grant and token issued by this Worker.
//
//   npm run oauth:revoke -- --local|--remote          count what would be deleted
//   npm run oauth:revoke -- --local|--remote --yes    delete it
//
// Deletes only the `grant:` and `token:` keys @cloudflare/workers-oauth-provider
// keeps in OAUTH_KV. Client registrations (`client:`) survive, so claude.ai can
// sign in again without re-registering; every connected client must approve
// the connection password again. Key names hold ids, never tokens or props.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectWranglerConfig } from "./lib/wrangler-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const local = args.includes("--local");
const remote = args.includes("--remote");
if (local === remote) {
  console.error("Usage: npm run oauth:revoke -- --local|--remote [--yes]");
  process.exit(2);
}
const where = local ? "--local" : "--remote";
const config = selectWranglerConfig(root);

function wrangler(extra, capture) {
  const result = spawnSync("npx", ["--no-install", "wrangler", ...extra, "--binding", "OAUTH_KV", where, "--config", config], {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

const keys = [];
for (const prefix of ["grant:", "token:"]) {
  const listed = JSON.parse(wrangler(["kv", "key", "list", "--prefix", prefix], true));
  keys.push(...listed.map((k) => k.name).filter((name) => name.startsWith(prefix)));
}
const grants = keys.filter((k) => k.startsWith("grant:")).length;
console.log(`${grants} grant(s) and ${keys.length - grants} token(s) in OAUTH_KV (${where.slice(2)}).`);
if (keys.length === 0) process.exit(0);
if (!args.includes("--yes")) {
  console.log("Nothing deleted. Re-run with --yes to revoke them all.");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "oauth-revoke-"));
try {
  const file = join(dir, "keys.json");
  writeFileSync(file, JSON.stringify(keys));
  wrangler(["kv", "bulk", "delete", file, "--force"], false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Revoked. Connected OAuth clients must sign in again.");
