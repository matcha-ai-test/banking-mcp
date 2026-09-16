/**
 * Enable Banking credential preflight.
 *
 * A mismatched Application ID and private key is the most common first-run
 * failure: Enable Banking answers 401 {"code":401,"message":"Wrong signature"}
 * and every later call looks like a generic "Internal error". Checking the pair
 * once, before any secret is written or deployed, turns that into a single
 * actionable message.
 *
 * The JWT is the same one src/eb.ts mints: RS256, header {alg, typ, kid:<appId>},
 * issuer "enablebanking.com", audience "api.enablebanking.com", one hour.
 */
import { SignJWT, importPKCS8 } from "jose";

const EB_BASE = "https://api.enablebanking.com";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreflightError";
  }
}

/** The Application ID is a UUID on the application's page in the Control Panel. */
export function looksLikeAppId(appId) {
  return UUID_RE.test((appId ?? "").trim());
}

export async function mintApplicationJwt(appId, pem) {
  const key = await importPKCS8(pem.trim(), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: appId, typ: "JWT" })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

export const WRONG_SIGNATURE_MESSAGE =
  "Enable Banking rejected the signature (401). The Application ID does not match the private key.\n" +
  "The Application ID is the UUID on the application's page in the Enable Banking Control Panel; the downloaded .pem file is usually named after it.\n" +
  "Check that the ID and the key file belong to the same application, then run setup again.";

/**
 * GET /application with the minted JWT.
 * Resolves with { name, environment, active } on 200 and throws PreflightError
 * otherwise. Response bodies are never surfaced beyond the status.
 */
export async function checkApplication(appId, pem, { fetchImpl = fetch } = {}) {
  if (!looksLikeAppId(appId)) {
    throw new PreflightError(
      `"${appId}" does not look like an Enable Banking Application ID. It is a UUID such as 12345678-90ab-4cde-8f01-234567890abc, copied from the application's page in the Control Panel (not the key file name).`
    );
  }

  let token;
  try {
    token = await mintApplicationJwt(appId, pem);
  } catch (e) {
    throw new PreflightError(`Could not sign a token with that private key: ${e.message}`);
  }

  let res;
  try {
    res = await fetchImpl(`${EB_BASE}/application`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // Without this a hung connection would stall the installer indefinitely,
      // at a point where nothing has been written yet.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? "timed out after 15 s" : e.message;
    throw new PreflightError(`Could not reach Enable Banking (${reason}). Check the network, or rerun with --skip-preflight.`);
  }

  if (res.status === 401) throw new PreflightError(WRONG_SIGNATURE_MESSAGE);
  if (!res.ok) throw new PreflightError(`Enable Banking request failed (${res.status}). Rerun with --skip-preflight to continue anyway.`);

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return {
    name: typeof body.name === "string" ? body.name : "",
    environment: typeof body.environment === "string" ? body.environment : "",
    active: body.active !== false,
  };
}

/** Run the check and report it on stdout. Throws PreflightError on failure. */
export async function runPreflight(appId, pem, { log = console.log, warn = console.warn, fetchImpl = fetch } = {}) {
  const app = await checkApplication(appId, pem, { fetchImpl });
  log(`Enable Banking application: ${app.name || "(unnamed)"}${app.environment ? ` (${app.environment})` : ""}`);
  if (!app.active) {
    warn(
      "This application is not active. A new application stays inactive until you activate it in the Control Panel by linking accounts; until then every bank call fails."
    );
  }
  return app;
}
