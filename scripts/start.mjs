#!/usr/bin/env node
/**
 *   npm start             local process; cloud D1 if already provisioned
 *   npm start -- --local  on-disk sandbox
 * Starts the local HTTP MCP endpoint. It does not open a browser.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectWranglerConfig } from "./lib/wrangler-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = /^0{8}-0{4}-0{4}-0{4}-0{11}[12]$/;
const forceLocal = process.argv.includes("--local");
const language = /^sv/i.test(process.env.LANG || "") ? "sv" : "en";
const tr = (en, sv) => (language === "sv" ? sv : en);
const URL = `http://127.0.0.1:8787/?lang=${language}`;

let remote = false;
const configPath = selectWranglerConfig(ROOT, { forceTracked: forceLocal });
if (!forceLocal) {
  const text = readFileSync(configPath, "utf8");
  const id = text.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1] ?? "";
  remote = Boolean(id) && !PLACEHOLDER.test(id);
}

const args = ["wrangler", "dev", "--ip", "127.0.0.1", "--port", "8787"];
if (remote) args.push("--remote");
args.push("--config", configPath);

console.log(
  remote
    ? tr("Starting locally against the cloud database.", "Startar lokalt mot molndatabasen.")
    : tr("Starting with the local database.", "Startar med den lokala databasen.")
);
console.log(`Status: ${URL}`);

const child = spawn("npx", ["--no-install", ...args], { cwd: ROOT, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
