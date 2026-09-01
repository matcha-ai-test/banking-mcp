import { SignJWT, importPKCS8 } from "jose";
import type { EbAccount, EbBalance, EbTransaction, Env, PsuType } from "./types";

const EB_BASE = "https://api.enablebanking.com";
const MAX_ERROR_BYTES = 4096;

async function limitedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    while (total < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BYTES - total;
      const chunk = value.subarray(0, remaining);
      total += chunk.byteLength;
      out += decoder.decode(chunk, { stream: total < MAX_ERROR_BYTES });
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

export class RateLimitError extends Error {
  constructor(msg = "ASPSP rate limit exceeded") {
    super(msg);
    this.name = "RateLimitError";
  }
}
export class ExpiredSessionError extends Error {
  constructor(msg = "Bank session expired") {
    super(msg);
    this.name = "ExpiredSessionError";
  }
}

export interface AuthStartResponse {
  url: string;
}
export interface SessionResponse {
  session_id: string;
  accounts: EbAccount[];
  access?: { valid_until?: string };
  aspsp?: { name?: string; country?: string };
  [k: string]: unknown;
}
export type Aspsp = {
  name: string;
  country: string;
  maximum_consent_validity?: number;
  psu_types?: string[];
};
export interface TransactionsResponse {
  transactions: EbTransaction[];
  continuation_key?: string | null;
}

export class EbClient {
  private jwt: string | null = null;
  private jwtExp = 0;
  private appId: string;
  private privateKey: string;

  constructor(env: Env) {
    if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) {
      throw new Error("EB_APP_ID / EB_PRIVATE_KEY secrets are not configured");
    }
    this.appId = env.EB_APP_ID;
    this.privateKey = env.EB_PRIVATE_KEY;
  }

  private async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now < this.jwtExp - 60) return this.jwt;
    const pem = this.privateKey.trim();
    if (pem.includes("BEGIN RSA PRIVATE KEY")) {
      throw new Error(
        "EB_PRIVATE_KEY is PKCS#1. Convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem"
      );
    }
    const key = await importPKCS8(pem, "RS256");
    this.jwtExp = now + 3600;
    this.jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: this.appId, typ: "JWT" })
      .setIssuer("enablebanking.com")
      .setAudience("api.enablebanking.com")
      .setIssuedAt(now)
      .setExpirationTime(this.jwtExp)
      .sign(key);
    return this.jwt;
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const token = await this.token();
    const res = await fetch(`${EB_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.ok) return res.json();

    const bodyText = await limitedText(res).catch(() => "");
    if (res.status === 429 || bodyText.includes("ASPSP_RATE_LIMIT_EXCEEDED")) {
      throw new RateLimitError();
    }
    if (bodyText.includes("EXPIRED_SESSION") || bodyText.includes("SESSION_EXPIRED")) {
      throw new ExpiredSessionError();
    }
    // Retry only idempotent reads: a POST (/auth, /sessions) that succeeded
    // server-side but answered 5xx must not be replayed with a spent code.
    if (res.status >= 500 && attempt < 3 && (init.method ?? "GET").toUpperCase() === "GET") {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.request<T>(path, init, attempt + 1);
    }
    throw new Error(`Enable Banking request failed (${res.status})`);
  }

  /** AIS banks. Omit country to get every Enable Banking ASPSP. */
  async getAspsps(country?: string): Promise<Aspsp[]> {
    const q = new URLSearchParams();
    if (country) q.set("country", country);
    q.set("service", "AIS");
    try {
      const data = await this.request<{ aspsps: Aspsp[] }>(`/aspsps?${q.toString()}`);
      return data.aspsps ?? [];
    } catch {
      q.delete("service");
      const data = await this.request<{ aspsps: Aspsp[] }>(`/aspsps?${q.toString()}`);
      return data.aspsps ?? [];
    }
  }

  async startAuth(opts: {
    validUntil: string;
    state: string;
    redirectUrl: string;
    psuType: PsuType;
    aspspName: string;
    aspspCountry: string;
  }): Promise<AuthStartResponse> {
    return this.request<AuthStartResponse>("/auth", {
      method: "POST",
      body: JSON.stringify({
        access: { valid_until: opts.validUntil },
        aspsp: { name: opts.aspspName, country: opts.aspspCountry },
        state: opts.state,
        redirect_url: opts.redirectUrl,
        psu_type: opts.psuType,
      }),
    });
  }

  async createSession(code: string): Promise<SessionResponse> {
    return this.request<SessionResponse>("/sessions", { method: "POST", body: JSON.stringify({ code }) });
  }

  async getBalances(accountUid: string): Promise<{ balances: EbBalance[] }> {
    return this.request(`/accounts/${encodeURIComponent(accountUid)}/balances`);
  }

  async getTransactions(
    accountUid: string,
    opts: { dateFrom?: string; dateTo?: string; continuationKey?: string } = {}
  ): Promise<TransactionsResponse> {
    const q = new URLSearchParams();
    if (opts.dateFrom) q.set("date_from", opts.dateFrom);
    if (opts.dateTo) q.set("date_to", opts.dateTo);
    if (opts.continuationKey) q.set("continuation_key", opts.continuationKey);
    const qs = q.toString();
    return this.request(`/accounts/${encodeURIComponent(accountUid)}/transactions${qs ? `?${qs}` : ""}`);
  }
}
