import { aspspRows } from "./aspsps";
import { Db } from "./db";
import { EbClient, type Aspsp } from "./eb";
import { assignAccountIdentities } from "./identity";
import { AUTH_LINK_CMD } from "./mcp-output";
import { authGatePage, esc, pageResponse } from "./pages";
import { backfillAccounts } from "./sync";
import type { AccountRow, EbAccount, Env, PsuType } from "./types";
import { AUTH_COOKIE_NAME, AUTH_COOKIE_TTL_MS, cookieFrom, maskIban, mintAuthCookie, rateLimitKey, secretsMatch, verifyAuthCookie } from "./util";

const MAX_CONSENT_DAYS = 180;
const AUTH_START_LIMIT_PER_HOUR = 10;
export const STATE_TTL_MINUTES = 15;

function authPage(title: string, body: string, status = 200): Response {
  return pageResponse({ title, body, status });
}

/** EbClient reports upstream failures as "Enable Banking request failed (<status>)". */
function ebStatus(error: unknown): number | null {
  const m = error instanceof Error ? error.message.match(/Enable Banking request failed \((\d{3})\)/) : null;
  return m ? Number(m[1]) : null;
}

/**
 * A key/Application ID mismatch is Enable Banking's 401 "Wrong signature", and
 * without this it surfaced as a bare "Internal error". Only the status is ever
 * shown: response bodies from the bank API do not belong on an operator page.
 */
export function enableBankingErrorPage(error: unknown): Response {
  const status = ebStatus(error);
  console.warn("Enable Banking call failed", { name: (error as Error)?.name, status });
  if (status === 401) {
    return authPage(
      "Enable Banking rejected the signature",
      `<h1>Enable Banking rejected the signature</h1><p>Enable Banking answered <code>401</code>: the request was signed with a private key that does not match the configured Application ID.</p><p>The Application ID is the UUID on the application's page in the Enable Banking Control Panel, and the downloaded key file is usually named after it. Check that the ID and the <code>.pem</code> file belong to the same application, then run <code>npm run install:mcp</code> again with the matching pair.</p>`,
      502
    );
  }
  return authPage(
    "Enable Banking request failed",
    `<h1>Enable Banking request failed${status ? ` (${status})` : ""}</h1><p>The call to Enable Banking did not succeed. Try the bank link again; if it continues, check the Application ID, the private key, and that the application is activated in the Enable Banking Control Panel.</p>`,
    502
  );
}

/**
 * Metadata the session response already carries, so persisting it costs no
 * bank call. A card number (CPAN) is reduced to its last four digits before
 * it reaches D1; the full PAN is never stored.
 */
export function accountMetadata(a: EbAccount): Pick<AccountRow, "cash_account_type" | "credit_limit_cents" | "usage" | "bic" | "card_last4"> {
  const cpan = (a.all_account_ids ?? []).find((id) => id?.scheme_name === "CPAN")?.identification;
  const digits = typeof cpan === "string" ? cpan.replace(/\D/g, "") : "";
  const limit = Number(a.credit_limit?.amount);
  return {
    cash_account_type: typeof a.cash_account_type === "string" ? a.cash_account_type : null,
    credit_limit_cents: a.credit_limit?.amount != null && Number.isFinite(limit) ? Math.round(limit * 100) : null,
    usage: typeof a.usage === "string" ? a.usage : null,
    bic: typeof a.account_servicer?.bic_fi === "string" ? a.account_servicer.bic_fi : null,
    card_last4: digits.length >= 4 ? digits.slice(-4) : null,
  };
}

/**
 * Prefer the singular identification_hash when the bank sent one; only fall
 * back to identification_hashes[] when it collapses to exactly one distinct
 * usable value. An array with two or more distinct values is ambiguous
 * (which one is the stable identifier?) and is treated as no hash at all,
 * same as an oversized or absent value.
 */
function resolveIdentificationHash(a: EbAccount): string | null {
  if (typeof a.identification_hash === "string" && a.identification_hash.length >= 1 && a.identification_hash.length <= 2048) {
    return a.identification_hash;
  }
  if (Array.isArray(a.identification_hashes)) {
    const distinct = new Set(
      a.identification_hashes.filter((h): h is string => typeof h === "string" && h.length >= 1 && h.length <= 2048)
    );
    if (distinct.size === 1) return [...distinct][0];
  }
  return null;
}

function operatorAuthorized(request: Request, env: Env): Promise<boolean> {
  return verifyAuthCookie(cookieFrom(request, AUTH_COOKIE_NAME), env.START_TOKEN);
}

/**
 * POST { k } → short-lived HttpOnly cookie. The operator link keeps the token
 * in the URL fragment, so it never appears in a request URL and therefore
 * never reaches Cloudflare's invocation logs; this endpoint receives it in the
 * request body instead.
 */
export async function handleAuthSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const db = new Db(env);
  if (!(await db.rateLimitOk(await rateLimitKey(request, "auth_session"), AUTH_START_LIMIT_PER_HOUR, 3600_000))) {
    return new Response("Too many attempts", { status: 429 });
  }
  let presented: unknown;
  try {
    presented = ((await request.json()) as { k?: unknown }).k;
  } catch {
    presented = null;
  }
  if (typeof presented !== "string" || !(await secretsMatch(presented, env.START_TOKEN))) {
    return new Response("Not found", { status: 404 });
  }
  // Secure only over https: Safari drops Secure cookies on plain-http loopback,
  // which would make local mode (http://127.0.0.1:8787) loop on the gate page.
  // SameSite=Strict: the gate page reloads same-site, so the cookie still
  // arrives there, but a cross-site top-level link cannot ride the cookie to
  // /auth/start and spend a bank authorization on the operator's behalf.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `${AUTH_COOKIE_NAME}=${await mintAuthCookie(env.START_TOKEN!)}; Path=/auth; Max-Age=${Math.floor(AUTH_COOKIE_TTL_MS / 1000)}; HttpOnly${secure}; SameSite=Strict`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function handleAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!(await operatorAuthorized(request, env))) {
    // The operator link carries the token in the fragment; serve the exchange
    // page that trades it for the cookie without putting it in any URL.
    return authGatePage();
  }
  const psuType = (url.searchParams.get("psu") === "business" ? "business" : "personal") as PsuType;
  const bankParam = url.searchParams.get("bank");
  const country = (url.searchParams.get("country") ?? "").toUpperCase();

  if (!bankParam) {
    return authPage(
      "No bank specified",
      `<h1>No bank specified</h1><p>Run <code>${esc(AUTH_LINK_CMD)}</code> on the operator machine and open the link it prints. The name must match Enable Banking's ASPSP name.</p>`,
      400
    );
  }

  const db = new Db(env);
  if (!(await db.rateLimitOk(await rateLimitKey(request, "auth_start"), AUTH_START_LIMIT_PER_HOUR, 3600_000))) {
    return authPage(
      "Too many attempts",
      `<h1>Too many attempts</h1><p>Max ${AUTH_START_LIMIT_PER_HOUR} authorization starts per hour. Try again later.</p>`,
      429
    );
  }

  const eb = new EbClient(env);
  let aspsps: Aspsp[];
  try {
    aspsps = country ? await eb.getAspsps(country) : await eb.getAspsps();
  } catch (e) {
    return enableBankingErrorPage(e);
  }
  // The list was fetched anyway; keep list_banks warm without a separate call.
  try { await db.upsertAspsps(aspspRows(aspsps)); } catch { /* cache only */ }
  const matches = aspsps.filter(
    (a) => a.name.toLowerCase() === bankParam.toLowerCase() && (!country || a.country.toUpperCase() === country)
  );
  if (!matches.length) {
    return authPage(
      "Unknown bank",
      `<h1>Unknown bank</h1><p><code>${esc(bankParam)}</code>${country ? ` in ${esc(country)}` : ""} is not in Enable Banking's list. The name must match the ASPSP name exactly. Pass <code>--country</code> if you did not.</p>`,
      400
    );
  }
  // Some providers (PayPal, for one) are listed once per country. Without a
  // country the first match would win silently and the session would come back
  // with no accounts, so refuse and ask for the country instead.
  const countries = [...new Set(matches.map((a) => a.country.toUpperCase()))];
  if (!country && countries.length > 1) {
    return authPage(
      "Bank exists in several countries",
      `<h1>Bank exists in several countries</h1><p><code>${esc(bankParam)}</code> is listed in ${esc(countries.join(", "))}. Run <code>${esc(AUTH_LINK_CMD)}</code> with the country you hold the account in.</p>`,
      400
    );
  }
  const bank = matches[0];
  if (bank.psu_types && !bank.psu_types.includes(psuType)) {
    return authPage(
      "Wrong account type",
      `<h1>Wrong account type</h1><p>${esc(bank.name)} does not support <code>${psuType}</code>. Available: ${esc(bank.psu_types.join(", "))}.</p>`,
      400
    );
  }
  const maxSeconds = bank.maximum_consent_validity ?? MAX_CONSENT_DAYS * 86400;
  const validUntil = new Date(Date.now() + Math.min(maxSeconds, MAX_CONSENT_DAYS * 86400) * 1000).toISOString();

  const state = crypto.randomUUID();
  await db.insertAuthState(state, psuType);

  let auth: { url: string };
  try {
    auth = await eb.startAuth({
      validUntil,
      state,
      redirectUrl: `${url.origin}/auth/callback`,
      psuType,
      aspspName: bank.name,
      aspspCountry: bank.country,
    });
  } catch (e) {
    return enableBankingErrorPage(e);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: auth.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return authPage(
      "Authorization canceled",
      `<h1>Authorization was canceled or rejected</h1><p>When you want to try again, run <code>${esc(AUTH_LINK_CMD)}</code> on the operator machine and open the new link.</p>`,
      400
    );
  }
  if (!code || !state || !/^[0-9a-f-]{36}$/i.test(state)) {
    return authPage("Invalid request", "<h1>Invalid request</h1><p>Missing code or state.</p>", 400);
  }

  const db = new Db(env);
  const psuType = await db.consumeAuthState(state, STATE_TTL_MINUTES);
  if (!psuType) {
    return authPage(
      "Expired or already used",
      `<h1>Expired or already used</h1><p>Run <code>${esc(AUTH_LINK_CMD)}</code> on the operator machine and open the new link.</p>`,
      400
    );
  }

  try {
    const eb = new EbClient(env);
    const session = await eb.createSession(code);
    const aspspName = session.aspsp?.name ?? "unknown";
    const aspspCountry = session.aspsp?.country ?? "SE";
    const sessionPk = crypto.randomUUID();

    const accountRows: AccountRow[] = (session.accounts ?? []).map((a) => ({
      account_uid: a.uid,
      session_pk: sessionPk,
      name: a.name ?? a.details ?? a.product ?? null,
      iban: a.account_id?.iban ?? null,
      identification_hash: resolveIdentificationHash(a),
      account_identity_id: null,
      currency: a.currency ?? null,
      psu_type: psuType,
      product: a.product ?? null,
      last_synced_at: null,
      ...accountMetadata(a),
    }));

    // An authorized session that returns no accounts is not a success: the
    // account is usually not linked to the app under Enable Banking Restricted
    // access, or the bank was chosen for the wrong country (PayPal is per
    // country). Say so, and persist nothing, so a mis-aimed re-authorization
    // can never replace a working session for the same bank.
    if (accountRows.length === 0) {
      return authPage(
        "Connected, but no accounts",
        `<h1>Connected, but no accounts</h1><p>${esc(aspspName)} (${psuType}) authorized, but Enable Banking returned no accounts. Link the account to the application in the Enable Banking Control Panel under Restricted access, or re-authorize for the correct country. Any existing session for this bank is unchanged.</p><p>Then run <code>${esc(AUTH_LINK_CMD)}</code> on the operator machine again. PayPal, for example, is listed per country.</p>`
      );
    }

    await db.replaceActiveSessions(psuType, aspspName);
    await db.insertSession({
      id: sessionPk,
      session_id: session.session_id,
      psu_type: psuType,
      valid_until: session.access?.valid_until ?? null,
      aspsp_name: aspspName,
      aspsp_country: aspspCountry,
    });
    await db.upsertAccounts(accountRows);

    // Resolve each account's stable registry identity before folding, so the
    // fold below can key on it. A conflicting identity fails closed: no fold,
    // no annotation attach for that account, existing generations are left as-is.
    const identities = await assignAccountIdentities(db, accountRows);

    // Re-auth mints fresh account_uids for the same IBANs; fold any prior generations into
    // the new uid so history stays under one account and the backfill's INSERT OR IGNORE
    // dedups against it. This also self-heals existing duplicates on the next bank authorization.
    const batchUids = accountRows.map((a) => a.account_uid);
    for (const a of accountRows) {
      const res = identities.get(a.account_uid);
      if (res && !res.ok && (res.reason === "identity_conflict" || res.reason === "transient_error")) {
        console.warn("identity conflict or transient error; generation left unfolded"); // counts/reason only
        continue; // fail closed: no fold, no annotation attach
      }
      const identityId = res?.ok ? res.id : null;
      const stale = await db.staleAccountGenerations(a.iban, a.currency, a.psu_type, a.account_uid, identityId, batchUids);
      for (const oldUid of stale) {
        const r = await db.foldAccountGeneration(oldUid, a.account_uid);
        // Counts only: account identifiers do not belong in Worker logs.
        console.log(`folded account generation: moved ${r.moved}, collapsed ${r.collapsed}`);
      }
    }

    const results = await backfillAccounts(env, accountRows);
    const total = results.reduce((s, r) => s + r.new_transactions, 0);
    const lines = results
      .map((r) => {
        const acc = accountRows.find((a) => a.account_uid === r.account_uid);
        const label = maskIban(acc?.iban) ?? `${r.account_uid.slice(0, 4)}…`;
        return `<li><code>${esc(label)}</code>: ${r.error ? `Error: ${esc(r.error)}` : `${r.new_transactions} transactions`}</li>`;
      })
      .join("");

    return authPage(
      "Bank connected",
      `<h1>Connected</h1><p>${esc(aspspName)} (${psuType}) is active until <strong>${esc((session.access?.valid_until ?? "").slice(0, 10))}</strong>.</p><p>${accountRows.length} account(s), ${total} transactions pulled in the first sync:</p><ul>${lines}</ul><p>You can close this tab. Claude and Codex can read the data now.</p>`
    );
  } catch (e) {
    console.warn("Bank session creation failed", { name: (e as Error).name });
    return authPage(
      "Could not create the bank session",
      "<h1>Could not create the bank session</h1><p>Try the bank link again. If it continues, check the Application ID, private key, and redirect URL.</p>",
      500
    );
  }
}
