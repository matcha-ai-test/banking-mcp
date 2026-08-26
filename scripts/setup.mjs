#!/usr/bin/env node
/**
 * One-shot installer.
 *
 *   npm run setup              asks: this computer / cloud / both
 *   npm run setup -- --local   this computer only
 *   npm run setup -- --cloud   cloud only
 *   npm run setup -- --both    this computer AND cloud (same secrets)
 *   npm run setup -- --print   rewrite the local client credentials file
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeClientCredentials } from "./lib/credentials.mjs";
import {
  ensureLocalWranglerConfig,
  localWranglerConfig,
  readBaseUrl,
  selectWranglerConfig,
  trackedWranglerConfig,
  writeLocalBaseUrl,
} from "./lib/wrangler-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS = join(ROOT, ".dev.vars");
const CREDENTIALS = join(ROOT, ".mcp-credentials");
const LOCAL_URL = "http://127.0.0.1:8787";

const args = new Set(process.argv.slice(2));
const optionValue = (name) => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const wantPrint = args.has("--print");
const nonInteractive = args.has("--yes") || !stdinStream.isTTY;
const langArg = process.argv.slice(2).find((arg) => arg.startsWith("--lang="))?.slice(7);
const language = langArg === "sv" || langArg === "en" ? langArg : /^sv/i.test(process.env.LANG || "") ? "sv" : "en";
const tr = (en, sv) => (language === "sv" ? sv : en);

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function fail(msg) {
  console.error(c.red("Error: ") + msg);
  process.exit(1);
}

function wrangler(argv, opts = {}) {
  const configPath = opts.configPath ?? selectWranglerConfig(ROOT);
  const r = spawnSync("npx", ["--no-install", "wrangler", ...argv, "--config", configPath], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.status !== 0 && !opts.allowFail) {
    fail(`wrangler ${argv.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || "") + (r.stderr || "");
}

function loadDotVars(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, "utf8");
  const re = /^([A-Z0-9_]+)=((?:"[\s\S]*?")|(?:'[\s\S]*?')|\S*)/gm;
  let m;
  while ((m = re.exec(text))) {
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v.replace(/\\n/g, "\n");
  }
  return out;
}

function writeDotVars(path, vars) {
  const body =
    Object.entries(vars)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function normalizePem(raw) {
  const text = raw.replace(/\r/g, "").trim();
  if (text.includes("BEGIN RSA PRIVATE KEY")) {
    fail(
      tr(
        "That key is PKCS#1. Convert it once:\n  openssl pkcs8 -topk8 -nocrypt -in your-key.pem -out key-pkcs8.pem\nThen rerun setup with key-pkcs8.pem",
        "Nyckeln är i PKCS#1-format. Konvertera den en gång:\n  openssl pkcs8 -topk8 -nocrypt -in din-nyckel.pem -out nyckel-pkcs8.pem\nKör sedan installationen igen med nyckel-pkcs8.pem"
      )
    );
  }
  if (!text.includes("BEGIN PRIVATE KEY") && !text.includes("BEGIN RSA PRIVATE KEY")) {
    fail(tr("That does not look like a PEM private key (missing BEGIN PRIVATE KEY).", "Filen ser inte ut som en privat PEM-nyckel (BEGIN PRIVATE KEY saknas)."));
  }
  return text;
}

function persistClientCredentials({ mcpSecret, startToken, localUrl, cloudUrl, mode }) {
  writeClientCredentials({
    filePath: CREDENTIALS,
    mcpSecret,
    startToken,
    localUrl,
    cloudUrl,
    mode,
    stdout: (line) => console.log(line),
  });
}

async function prompt(rl, question, fallback = "") {
  if (!rl) return fallback;
  const hint = fallback ? ` [${fallback}]` : "";
  const a = (await rl.question(`${question}${hint}: `)).trim();
  return a || fallback;
}

function putSecrets(pairs) {
  for (const [name, value] of pairs) {
    execFileSync(
      "npx",
      ["--no-install", "wrangler", "secret", "put", name, "--config", selectWranglerConfig(ROOT)],
      {
        cwd: ROOT,
        input: value,
        stdio: ["pipe", "inherit", "inherit"],
        env: process.env,
      }
    );
  }
}

function ensureCloudLoggedIn() {
  console.log(tr("A browser window may open for Cloudflare login.", "Ett webbläsarfönster kan öppnas för inloggning på Cloudflare."));
  const who = wrangler(["whoami"], { allowFail: true });
  if (/not authenticated|not logged in/i.test(who) || (/error/i.test(who) && /login/i.test(who))) {
    wrangler(["login"], { stdio: "inherit" });
  } else {
    console.log(who.trim());
  }
}

function deployWorker() {
  console.log(tr("Deploying Worker (Cloudflare provisions D1 + KV automatically on first deploy)…", "Publicerar Worker (Cloudflare skapar D1 + KV automatiskt första gången)…"));
  const deployOut = wrangler(["deploy"]);
  const publicUrl = (deployOut.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) || [])[0];
  if (!publicUrl) fail(tr("Deploy succeeded but no workers.dev URL was printed.", "Publiceringen lyckades men ingen workers.dev-adress visades."));
  return publicUrl;
}

function configuredCloudUrl() {
  const local = localWranglerConfig(ROOT);
  if (!existsSync(local)) return "";
  const url = readBaseUrl(local);
  return /^https:\/\//.test(url) ? url : "";
}

function printEnableBankingRegistration(cloudUrl) {
  const base = cloudUrl.replace(/\/$/, "");
  console.log("");
  console.log(c.bold(tr("Enable Banking application URLs", "Adresser till Enable Banking-applikationen")));
  console.log("");
  console.log(tr("Create or edit the application at https://enablebanking.com/cp/applications and use:", "Skapa eller redigera applikationen på https://enablebanking.com/cp/applications och använd:"));
  console.log(`  Redirect URL:  ${base}/auth/callback`);
  console.log(`  Privacy URL:   ${base}/privacy`);
  console.log(`  Terms URL:     ${base}/terms`);
  console.log("");
  console.log(c.dim(tr("Choose Production for real bank data and Generate in the browser with private-key export.", "Välj Production för riktig bankdata och Generate in the browser med export av privat nyckel.")));
  console.log(c.dim(tr("Registration downloads the private .pem file. Return here with the Application ID and that file path.", "Registreringen laddar ned den privata .pem-filen. Återvänd hit med Application ID och sökvägen till filen.")));
  console.log(c.dim(tr("For restricted personal use, activate the app by linking your own accounts.", "För begränsad privat användning aktiverar du appen genom att länka dina egna konton.")));
  console.log("");
}

function configureCloudSecrets(secrets) {
  putSecrets([
    ["EB_APP_ID", secrets.appId],
    ["EB_PRIVATE_KEY", secrets.pem],
    ["MCP_SECRET", secrets.mcpSecret],
    ["START_TOKEN", secrets.startToken],
  ]);
}

if (wantPrint) {
  const vars = loadDotVars(DEV_VARS);
  if (!vars.MCP_SECRET || !vars.START_TOKEN) fail("No .dev.vars yet. Run npm run setup first.");
  const cloudUrl = vars.CLOUD_URL || "";
  const mode = vars.INSTALL_MODE || (cloudUrl ? "cloud" : "local");
  persistClientCredentials({
    mcpSecret: vars.MCP_SECRET,
    startToken: vars.START_TOKEN,
    localUrl: vars.BASE_URL || LOCAL_URL,
    cloudUrl,
    mode,
  });
  process.exit(0);
}

const rl = nonInteractive ? null : createInterface({ input: stdinStream, output: stdoutStream });

console.log("");
console.log(c.bold("banking-mcp setup"));
console.log(tr("Read-only bank access for Claude and Codex. Payments stay off.", "Skrivskyddad bankåtkomst för Claude och Codex. Betalningar är avstängda."));
console.log("");

let mode = "local";
if (args.has("--both")) mode = "both";
else if (args.has("--cloud")) mode = "cloud";
else if (args.has("--local")) mode = "local";
else if (rl) {
  console.log(c.bold(tr("First: where should it run?", "Först: var ska servern köras?")));
  console.log(tr("  1) This computer only   (no Cloudflare account)", "  1) Endast den här datorn  (inget Cloudflare-konto)"));
  console.log(tr("  2) Cloud only           (Claude.ai / Codex Cloud / phone)  ", "  2) Endast moln            (Claude.ai / Codex Cloud / telefon)  ") + c.bold(tr("recommended", "rekommenderas")));
  console.log(tr("  3) Both                 (local + cloud)", "  3) Båda                   (lokalt + moln)"));
  console.log("");
  const choice = await prompt(rl, tr("Choose 1, 2 or 3", "Välj 1, 2 eller 3"), "2");
  mode = choice === "1" ? "local" : choice === "2" ? "cloud" : "both";
} else if (nonInteractive) {
  mode = "local";
}

const existing = loadDotVars(DEV_VARS);
const wantLocal = mode === "local" || mode === "both";
const wantCloud = mode === "cloud" || mode === "both";

let cloudUrl = existing.CLOUD_URL || configuredCloudUrl();
if (wantCloud) {
  console.log("");
  console.log(c.bold("Cloudflare"));
  ensureLocalWranglerConfig(ROOT);
  if (cloudUrl) writeLocalBaseUrl(ROOT, cloudUrl);
  ensureCloudLoggedIn();

  // A new Enable Banking production application needs public callback,
  // privacy and terms URLs before it can issue the Application ID and key.
  // Deploy an unconfigured shell first to break that dependency cycle.
  if (!cloudUrl) {
    cloudUrl = deployWorker();
    writeLocalBaseUrl(ROOT, cloudUrl);
    cloudUrl = deployWorker();
  }
  printEnableBankingRegistration(cloudUrl);
}

console.log(tr("You now need:", "Nu behöver du:"));
console.log(tr("  1. An Enable Banking Application ID", "  1. Ett Enable Banking Application ID"));
console.log(tr("  2. Its downloaded private key (.pem)", "  2. Den nedladdade privata nyckeln (.pem)"));
console.log(tr("  3. The linked accounts activated in Enable Banking", "  3. Dina konton länkade och applikationen aktiverad i Enable Banking"));
console.log(tr("Linking accounts whitelists them. banking-mcp will still start a separate bank authorisation to create the API session.", "Länkningen vitlistar kontona. banking-mcp startar därefter ändå en separat bankauktorisering för att skapa API-sessionen."));
console.log("");

let appId = optionValue("--app-id") || process.env.EB_APP_ID || existing.EB_APP_ID || "";
let pem = process.env.EB_PRIVATE_KEY || existing.EB_PRIVATE_KEY || "";
const suppliedKeyPath = optionValue("--key-file");

function readKeyFile(keyPath) {
  const abs = resolve(keyPath.replace(/^~/, process.env.HOME || ""));
  if (!existsSync(abs)) fail(tr(`No file at ${abs}`, `Det finns ingen fil på ${abs}`));
  return readFileSync(abs, "utf8");
}

if (suppliedKeyPath) pem = readKeyFile(suppliedKeyPath);

if (rl) {
  appId = await prompt(rl, "Enable Banking Application ID", appId);
  const keyPath = suppliedKeyPath ? "" : await prompt(rl, tr("Path to the .pem private key (or leave empty to keep current)", "Sökväg till den privata .pem-nyckeln (eller tomt för att behålla nuvarande)"), "");
  if (keyPath) pem = readKeyFile(keyPath);
}

if (!appId) {
  if (cloudUrl) printEnableBankingRegistration(cloudUrl);
  fail(
    cloudUrl
      ? tr("Missing Application ID. Register the Enable Banking application using the URLs above, then rerun setup.", "Application ID saknas. Registrera Enable Banking-appen med adresserna ovan och kör sedan installationen igen.")
      : tr("Missing Application ID. Get it from the Enable Banking control panel, then rerun setup.", "Application ID saknas. Hämta det i Enable Banking Control Panel och kör sedan installationen igen.")
  );
}
if (!pem) {
  if (cloudUrl) printEnableBankingRegistration(cloudUrl);
  fail(tr("Missing private key. Pass the downloaded .pem path to setup.", "Den privata nyckeln saknas. Ange sökvägen till den nedladdade .pem-filen."));
}
pem = normalizePem(pem);

const mcpSecret = existing.MCP_SECRET || randomBytes(24).toString("hex");
const startToken = existing.START_TOKEN || randomBytes(16).toString("hex");

function persistDevVars(extra = {}) {
  writeDotVars(DEV_VARS, {
    EB_APP_ID: appId,
    EB_PRIVATE_KEY: pem,
    MCP_SECRET: mcpSecret,
    START_TOKEN: startToken,
    BASE_URL: LOCAL_URL,
    INSTALL_MODE: mode,
    ...extra,
  });
}

persistDevVars(cloudUrl ? { CLOUD_URL: cloudUrl } : {});
console.log(c.green("✓") + tr(" Wrote .dev.vars (kept out of Git)", " Sparade .dev.vars (filen undantas från Git)"));

if (mode === "local") {
  console.log(c.dim(tr("Applying local database schema…", "Skapar den lokala databasen…")));
  wrangler(["d1", "execute", "banking-mcp-db", "--local", "--file=schema.sql"], {
    configPath: trackedWranglerConfig(ROOT),
  });
  console.log(c.green("✓") + tr(" Local database ready", " Den lokala databasen är klar"));
}

if (wantCloud) {
  configureCloudSecrets({ appId, pem, mcpSecret, startToken });
  cloudUrl = deployWorker();
  writeLocalBaseUrl(ROOT, cloudUrl);
  persistDevVars({ CLOUD_URL: cloudUrl });
  console.log(c.green("✓") + tr(" Cloud deployment completed", " Molnpubliceringen är klar"));
}

persistClientCredentials({ mcpSecret, startToken, localUrl: LOCAL_URL, cloudUrl, mode });

if (wantLocal) {
  console.log(c.bold(tr("Start on this computer:", "Starta på den här datorn:")));
  console.log("");
  console.log("  npm start");
  console.log("");
  if (mode === "both") {
    console.log(c.dim(tr("npm start uses the cloud database, so local and cloud clients see the same accounts.", "npm start använder molndatabasen, så lokala klienter och molnklienter ser samma konton.")));
    console.log(c.dim(tr("Empty local sandbox instead: npm start -- --local", "Tom lokal testdatabas i stället: npm start -- --local")));
  }
}

if (rl) rl.close();
