#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bankLink } from "./lib/credentials.mjs";
import { readBaseUrl, selectWranglerConfig } from "./lib/wrangler-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath = join(root, ".dev.vars");

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function loadStartToken(path) {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const raw = text.match(/^START_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return "";
    }
  }
  return raw.replace(/^['"]|['"]$/g, "");
}

const startToken = loadStartToken(devVarsPath);
if (!startToken) {
  fail("START_TOKEN is missing from .dev.vars. Run setup locally or add the operator token there; Cloudflare secrets cannot be read back.");
}

const configPath = selectWranglerConfig(root);
const baseUrl = readBaseUrl(configPath);
if (!baseUrl) fail(`BASE_URL is missing from ${configPath}.`);

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

// The operator names the bank they already linked in the Enable Banking Control
// Panel; the server starts the session for it. There is no in-app bank browser.
const bank = arg("bank");
if (!bank) {
  fail("Name the bank: npm run auth:link -- --bank=<ASPSP name> [--psu=business] [--country=SE]. It must match Enable Banking's ASPSP name.");
}
const psu = arg("psu") === "business" ? "business" : "personal";
const country = arg("country");

// This command is intentionally operator-only: the tokenized link is printed
// only in the local terminal and is never returned through MCP.
console.log(bankLink(baseUrl, startToken, { bank, psu, country }));
