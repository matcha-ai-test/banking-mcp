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

export function ensureLocalWranglerConfig(root) {
  const local = localWranglerConfig(root);
  if (!existsSync(local)) {
    writeFileSync(local, readFileSync(trackedWranglerConfig(root), "utf8"), { mode: 0o600 });
  }
  return local;
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
