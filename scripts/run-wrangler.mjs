#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectWranglerConfig } from "./lib/wrangler-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const hasConfigArg = args.some((arg) => arg === "--config" || arg.startsWith("--config="));
const configArgs = hasConfigArg ? [] : ["--config", selectWranglerConfig(root)];
const result = spawnSync("npx", ["--no-install", "wrangler", ...args, ...configArgs], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
