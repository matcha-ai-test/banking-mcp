import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function trackedWranglerConfig(root) {
  return join(root, "wrangler.jsonc");
}

export function localWranglerConfig(root) {
  return join(root, "wrangler.local.jsonc");
}

export function selectWranglerConfig(root, { forceTracked = false } = {}) {
  const local = localWranglerConfig(root);
  return !forceTracked && existsSync(local) ? local : trackedWranglerConfig(root);
}

export function readBaseUrl(configPath) {
  const text = readFileSync(configPath, "utf8");
  return (text.match(/"BASE_URL"\s*:\s*"([^"]+)"/)?.[1] ?? "").replace(/\/$/, "");
}

export const DEFAULT_WORKER_NAME = "banking-mcp";

/** Cloudflare Worker names: lowercase, digits and hyphens, up to 63 characters. */
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The tracked wrangler.jsonc hardcodes one Worker and one D1 name, so a second
 * install in the same Cloudflare account would overwrite the first. The names
 * are chosen once, when wrangler.local.jsonc is created.
 */
export function deriveWorkerNames(workerName) {
  const name = (workerName ?? "").trim() || DEFAULT_WORKER_NAME;
  if (!WORKER_NAME_RE.test(name)) {
    throw new Error(
      `"${name}" is not a valid Worker name. Use lowercase letters, digits and hyphens, for example banking-mcp-personal.`
    );
  }
  return { workerName: name, databaseName: `${name}-db` };
}

/** Rewrite the top-level "name" and the D1 "database_name" in a wrangler config. */
export function applyWorkerNames(text, { workerName, databaseName }) {
  return text
    .replace(/("name"\s*:\s*")[^"]*(")/, `$1${workerName}$2`)
    .replace(/("database_name"\s*:\s*")[^"]*(")/, `$1${databaseName}$2`);
}

export function ensureLocalWranglerConfig(root, { workerName } = {}) {
  const local = localWranglerConfig(root);
  if (!existsSync(local)) {
    const names = deriveWorkerNames(workerName);
    const text = applyWorkerNames(readFileSync(trackedWranglerConfig(root), "utf8"), names);
    writeFileSync(local, text, { mode: 0o600 });
  }
  return local;
}

export function readWorkerNames(configPath) {
  const text = readFileSync(configPath, "utf8");
  return {
    workerName: text.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? "",
    databaseName: text.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1] ?? "",
  };
}

export function writeLocalBaseUrl(root, baseUrl) {
  const local = ensureLocalWranglerConfig(root);
  const current = readFileSync(local, "utf8");
  const next = current.replace(/("BASE_URL"\s*:\s*")[^"]+"/, `$1${baseUrl.replace(/\/$/, "")}"`);
  if (next === current && readBaseUrl(local) !== baseUrl.replace(/\/$/, "")) {
    throw new Error("wrangler config has no BASE_URL value to override");
  }
  writeFileSync(local, next, { mode: 0o600 });
  return local;
}
