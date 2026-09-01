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
const forceLocal = process.argv.includes("--local");
const URL = "http://127.0.0.1:8787/";

// A database_id in the selected config means the cloud D1 has been provisioned.
let remote = false;
const configPath = selectWranglerConfig(ROOT, { forceTracked: forceLocal });
if (!forceLocal) {
  remote = /"database_id"\s*:\s*"[^"]+"/.test(readFileSync(configPath, "utf8"));
}

const args = ["wrangler", "dev", "--ip", "127.0.0.1", "--port", "8787"];
if (remote) args.push("--remote");
args.push("--config", configPath);

console.log(remote ? "Starting locally against the cloud database." : "Starting with the local database.");
console.log(`Status: ${URL}`);

const child = spawn("npx", ["--no-install", ...args], { cwd: ROOT, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
