// Shared test infrastructure: extension resolver for the src/*.ts imports, a D1
// shim over node:sqlite, a fake Env with a real RSA key, and an Enable Banking
// fetch mock. Import this module BEFORE dynamically importing anything under src/.

import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// src/*.ts imports each other without extensions ("./db"); Node's ESM loader
// needs them, so try "<specifier>.ts" for relative specifiers that lack one.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { migrate } = await import("../src/migrate.ts");
const { mintAuthCookie, AUTH_COOKIE_NAME } = await import("../src/util.ts");

/** Minimal D1Database over node:sqlite; enough for src/db.ts and src/migrate.ts. */
export function createD1() {
  const sqlite = new DatabaseSync(":memory:");

  const normalize = (p) => (p === undefined ? null : p);

  function statement(sql, params = []) {
    return {
      bind(...next) {
        // D1 returns a new statement per bind; db.ts relies on that when it
        // maps one prepared statement over many rows for batch().
        return statement(sql, next.map(normalize));
      },
      async run() {
        const r = sqlite.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...params), meta: {} };
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
    };
  }

  return {
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    /** Raw access for assertions. */
    sqlite,
    close: () => sqlite.close(),
  };
}

let cachedPem = null;
/** PKCS#8 PEM so EbClient can sign its JWT with jose. Generated once per process. */
export function testPrivateKeyPem() {
  if (!cachedPem) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cachedPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }
  return cachedPem;
}

export const TEST_START_TOKEN = "test-start-token";

/** Fresh migrated D1 shim and a fake Env for one test. */
export async function createEnv() {
  const DB = createD1();
  await migrate(DB);
  return {
    DB,
    START_TOKEN: TEST_START_TOKEN,
    MCP_SECRET: "test-mcp-secret",
    EB_APP_ID: "00000000-0000-4000-8000-000000000000",
    EB_PRIVATE_KEY: testPrivateKeyPem(),
  };
}

export async function authCookieHeader(secret = TEST_START_TOKEN) {
  return `${AUTH_COOKIE_NAME}=${await mintAuthCookie(secret)}`;
}

const EB_BASE = "https://api.enablebanking.com";

/**
 * Replace globalThis.fetch for the duration of a test. Only Enable Banking
 * URLs are answered (via `routes`); anything else throws so a test can never
 * reach the network. `routes` maps "METHOD /path" to a body or a
 * (url, init) => body function. Returns a restore function and the call log.
 */
export function mockEnableBanking(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!url.href.startsWith(EB_BASE)) throw new Error(`unexpected fetch: ${url.href}`);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, search: url.searchParams, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${method} ${url.pathname}`];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: "not mocked" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const body = typeof handler === "function" ? await handler(url, init) : handler;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function request(url, { method = "GET", headers = {}, body, ip } = {}) {
  const h = new Headers(headers);
  if (ip) h.set("CF-Connecting-IP", ip);
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  }
  return new Request(url, init);
}
