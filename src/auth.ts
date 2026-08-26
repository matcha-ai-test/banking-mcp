import { Db } from "./db";
import { EbClient, type Aspsp } from "./eb";
import { bankPickerPage, esc, languageFromRequest, pageResponse, type Lang } from "./pages";
import { backfillAccounts } from "./sync";
import type { AccountRow, Env, PsuType } from "./types";
import { maskIban, rateLimitKey, secretsMatch } from "./util";

const MAX_CONSENT_DAYS = 180;
const AUTH_START_LIMIT_PER_HOUR = 10;
const STATE_TTL_MINUTES = 15;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}

function authPage(request: Request, lang: Lang, title: string, body: string, status = 200): Response {
  return pageResponse({ title, body, status, lang, currentUrl: request.url });
}

export async function handleAuthBanks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!(await secretsMatch(url.searchParams.get("k"), env.START_TOKEN))) {
    return new Response("Not found", { status: 404 });
  }
  const country = (url.searchParams.get("country") ?? "").toUpperCase();
  const eb = new EbClient(env);
  const aspsps = await eb.getAspsps(country || undefined);
  const banks = aspsps.map((a) => ({
    name: a.name,
    country: a.country,
    psu_types: a.psu_types ?? ["personal", "business"],
  }));
  const countries = [...new Set(banks.map((b) => b.country))].sort();
  return json({ banks, countries });
}

export async function handleAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const lang = languageFromRequest(request);
  if (!(await secretsMatch(url.searchParams.get("k"), env.START_TOKEN))) {
    return new Response("Not found", { status: 404 });
  }
  const psuType = (url.searchParams.get("psu") === "business" ? "business" : "personal") as PsuType;
  const bankParam = url.searchParams.get("bank");
  const country = (url.searchParams.get("country") ?? "").toUpperCase();

  if (!bankParam) {
    return bankPickerPage(request);
  }

  const db = new Db(env);
  if (!(await db.rateLimitOk(await rateLimitKey(request, "auth_start"), AUTH_START_LIMIT_PER_HOUR, 3600_000))) {
    return authPage(
      request,
      lang,
      lang === "sv" ? "För många försök" : "Too many attempts",
      lang === "sv"
        ? `<h1>För många försök</h1><p>Högst ${AUTH_START_LIMIT_PER_HOUR} bankanslutningar kan startas per timme. Försök igen senare.</p>`
        : `<h1>Too many attempts</h1><p>Max ${AUTH_START_LIMIT_PER_HOUR} authorisation starts per hour. Try again later.</p>`,
      429
    );
  }

  const eb = new EbClient(env);
  let aspsps: Aspsp[] = [];
  if (country) aspsps = await eb.getAspsps(country);
  if (!aspsps.length) aspsps = await eb.getAspsps();
  const bank = aspsps.find(
    (a) => a.name.toLowerCase() === bankParam.toLowerCase() && (!country || a.country.toUpperCase() === country)
  );
  if (!bank) {
    const retry = `/auth/start?k=${encodeURIComponent(url.searchParams.get("k") ?? "")}&lang=${lang}`;
    return authPage(
      request,
      lang,
      lang === "sv" ? "Okänd bank" : "Unknown bank",
      lang === "sv"
        ? `<h1>Okänd bank</h1><p><a href="${retry}">Välj en bank från listan</a>. Enable Bankings namn måste matcha exakt.</p>`
        : `<h1>Unknown bank</h1><p><a href="${retry}">Pick a bank from the list</a>. Enable Banking names must match exactly.</p>`,
      400
    );
  }
  if (bank.psu_types && !bank.psu_types.includes(psuType)) {
    return authPage(
      request,
      lang,
      lang === "sv" ? "Fel kontotyp" : "Wrong account type",
      lang === "sv"
        ? `<h1>Fel kontotyp</h1><p>${esc(bank.name)} stöder inte <code>${psuType}</code>. Tillgängliga typer: ${esc(bank.psu_types.join(", "))}.</p>`
        : `<h1>Wrong account type</h1><p>${esc(bank.name)} does not support <code>${psuType}</code>. Available: ${esc(bank.psu_types.join(", "))}.</p>`,
      400
    );
  }
  const maxSeconds = bank.maximum_consent_validity ?? MAX_CONSENT_DAYS * 86400;
  const validUntil = new Date(Date.now() + Math.min(maxSeconds, MAX_CONSENT_DAYS * 86400) * 1000).toISOString();

  const state = crypto.randomUUID();
  await db.insertAuthState(state, psuType);

  const auth = await eb.startAuth({
    validUntil,
    state,
    redirectUrl: `${url.origin}/auth/callback`,
    psuType,
    aspspName: bank.name,
    aspspCountry: bank.country,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: auth.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const lang = languageFromRequest(request);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return authPage(
      request,
      lang,
      lang === "sv" ? "Bankanslutningen avbröts" : "Authorisation cancelled",
      lang === "sv"
        ? "<h1>Bankanslutningen avbröts eller nekades</h1><p>Starta om från <strong>Välj bank</strong> när du vill försöka igen.</p>"
        : "<h1>Authorisation was cancelled or rejected</h1><p>Restart from <strong>Choose bank</strong> when you want to try again.</p>",
      400
    );
  }
  if (!code || !state || !/^[0-9a-f-]{36}$/i.test(state)) {
    return authPage(request, lang, lang === "sv" ? "Ogiltig begäran" : "Invalid request", lang === "sv" ? "<h1>Ogiltig begäran</h1><p>Kod eller state saknas.</p>" : "<h1>Invalid request</h1><p>Missing code or state.</p>", 400);
  }

  const db = new Db(env);
  const psuType = await db.consumeAuthState(state, STATE_TTL_MINUTES);
  if (!psuType) {
    return authPage(
      request,
      lang,
      lang === "sv" ? "Länken har gått ut" : "Expired or already used",
      lang === "sv" ? "<h1>Länken har gått ut eller har redan använts</h1><p>Öppna banklänken som installationsskriptet visade och välj banken igen.</p>" : "<h1>Expired or already used</h1><p>Open the bank link printed by the installer and choose the bank again.</p>",
      400
    );
  }

  try {
    const eb = new EbClient(env);
    const session = await eb.createSession(code);
    const aspspName = session.aspsp?.name ?? "unknown";
    const aspspCountry = session.aspsp?.country ?? "SE";

    await db.replaceActiveSessions(psuType, aspspName);

    const sessionPk = crypto.randomUUID();
    await db.insertSession({
      id: sessionPk,
      session_id: session.session_id,
      psu_type: psuType,
      valid_until: session.access?.valid_until ?? null,
      aspsp_name: aspspName,
      aspsp_country: aspspCountry,
    });

    const accountRows: AccountRow[] = (session.accounts ?? []).map((a) => ({
      account_uid: a.uid,
      session_pk: sessionPk,
      name: a.name ?? a.details ?? a.product ?? null,
      iban: a.account_id?.iban ?? null,
      currency: a.currency ?? null,
      psu_type: psuType,
      product: a.product ?? null,
      last_synced_at: null,
    }));
    await db.upsertAccounts(accountRows);

    // Re-auth mints fresh account_uids for the same IBANs; fold any prior generations into
    // the new uid so history stays under one account and the backfill's INSERT OR IGNORE
    // dedups against it. This also self-heals existing duplicates on the next BankID login.
    for (const a of accountRows) {
      const stale = await db.staleAccountGenerations(a.iban, a.currency, a.psu_type, a.account_uid);
      for (const oldUid of stale) {
        const r = await db.foldAccountGeneration(oldUid, a.account_uid);
        console.log(`folded ${oldUid} -> ${a.account_uid}: moved ${r.moved}, collapsed ${r.collapsed}`);
      }
    }

    const results = await backfillAccounts(env, accountRows);
    const total = results.reduce((s, r) => s + r.new_transactions, 0);
    const lines = results
      .map((r) => {
        const acc = accountRows.find((a) => a.account_uid === r.account_uid);
        const label = maskIban(acc?.iban) ?? `${r.account_uid.slice(0, 4)}…`;
        return `<li><code>${esc(label)}</code>: ${r.error ? `${lang === "sv" ? "Fel" : "Error"}: ${esc(r.error)}` : `${r.new_transactions} ${lang === "sv" ? "transaktioner" : "transactions"}`}</li>`;
      })
      .join("");

    return authPage(
      request,
      lang,
      lang === "sv" ? "Banken är ansluten" : "Bank connected",
      lang === "sv"
        ? `<h1>Banken är ansluten</h1><p>${esc(aspspName)} (${psuType}) är aktiv till <strong>${esc((session.access?.valid_until ?? "").slice(0, 10))}</strong>.</p><p>${accountRows.length} konton och ${total} transaktioner hämtades i den första synkningen:</p><ul>${lines}</ul><p>Du kan stänga fliken. Claude och Codex kan nu läsa informationen.</p>`
        : `<h1>Connected</h1><p>${esc(aspspName)} (${psuType}) is active until <strong>${esc((session.access?.valid_until ?? "").slice(0, 10))}</strong>.</p><p>${accountRows.length} account(s), ${total} transactions pulled in the first sync:</p><ul>${lines}</ul><p>You can close this tab. Claude and Codex can read the data now.</p>`
    );
  } catch (e) {
    console.warn("Bank session creation failed", { name: (e as Error).name });
    return authPage(
      request,
      lang,
      lang === "sv" ? "Bankanslutningen misslyckades" : "Could not create the bank session",
      lang === "sv" ? "<h1>Bankanslutningen kunde inte skapas</h1><p>Försök igen från banklänken. Om felet kvarstår kontrollerar du Application ID, privat nyckel och redirect URL.</p>" : "<h1>Could not create the bank session</h1><p>Try the bank link again. If it continues, check the Application ID, private key, and redirect URL.</p>",
      500
    );
  }
}
