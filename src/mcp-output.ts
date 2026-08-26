import type { EbSessionRow } from "./types";

export const RENEWAL_HINT =
  "Run 'npm run auth:link' on the operator machine to print a bank re-authorization link.";
export const REFRESH_BUDGET_PER_DAY = 3;

const CACHED_NOTE =
  "Session metadata is cached; last_live_* shows the most recent verified bank call.";

function daysUntil(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - nowMs) / 86400_000);
}

/** Build warning text without accepting or serializing any operator secret. */
export function buildSessionWarnings(sessions: EbSessionRow[], nowMs = Date.now()): string {
  const lines: string[] = [];
  for (const session of sessions) {
    const left = daysUntil(session.valid_until, nowMs);
    if (session.status === "expired" || session.renewal_due === 1 || (left !== null && left < 14)) {
      const timing =
        session.status === "expired" ? "has expired" : left === null ? "needs renewal" : `expires in ${left} days`;
      lines.push(`⚠️ ${session.aspsp_name} session (${session.psu_type}) ${timing}. ${RENEWAL_HINT}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

/** Build the cached auth-status payload. Unknown properties are deliberately not copied. */
export function buildAuthStatus(sessions: EbSessionRow[], today = new Date().toISOString().slice(0, 10)) {
  return {
    note: CACHED_NOTE,
    renewal: RENEWAL_HINT,
    sessions: sessions.map((session) => ({
      bank: session.aspsp_name,
      country: session.aspsp_country,
      psu_type: session.psu_type,
      cached: true as const,
      cached_status: session.status,
      cached_valid_until: session.valid_until,
      days_left_from_cached_valid_until: daysUntil(session.valid_until),
      last_live_verified_at: session.last_live_verified_at,
      last_live_result: session.last_live_result,
      renewal_due: session.renewal_due === 1,
      refreshes_used_today: session.refresh_count_date === today ? session.refresh_count_today : 0,
      refresh_budget_per_day: REFRESH_BUDGET_PER_DAY,
      rate_limit_backoff_until: session.backoff_until,
    })),
    add_bank:
      "To connect another bank, first whitelist its accounts in the Enable Banking Control Panel, then run 'npm run auth:link' on the operator machine.",
    add_business:
      "To add business accounts, use the operator link, choose Business, and complete the bank login. Accounts must be whitelisted first.",
  };
}

export function serializeMcpText(warning: string, data: unknown) {
  return { content: [{ type: "text" as const, text: warning + JSON.stringify(data, null, 2) }] };
}
