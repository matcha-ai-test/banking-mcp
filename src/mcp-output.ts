import type { AuthStatusSessionRow } from "./types";
import type { LiveSessionResult } from "./auth-status";

/** The one operator command for connecting or renewing a bank; every hint and page quotes this. */
export const AUTH_LINK_CMD = "npm run auth:link -- --bank=<ASPSP name> --country=<ISO code> [--psu=business]";
export const RENEWAL_HINT = `Run '${AUTH_LINK_CMD}' on the operator machine to print a bank re-authorization link.`;
export const REFRESH_BUDGET_PER_DAY = 3;

const CACHED_NOTE =
  "Session metadata is cached; last_live_* shows the most recent verified bank call.";

function daysUntil(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - nowMs) / 86400_000);
}

/** Build warning text without accepting or serializing any operator secret. */
export function buildSessionWarnings(sessions: AuthStatusSessionRow[], nowMs = Date.now()): string {
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
export function buildAuthStatus(
  sessions: AuthStatusSessionRow[],
  today = new Date().toISOString().slice(0, 10),
  liveResults?: LiveSessionResult[]
) {
  return {
    note: CACHED_NOTE,
    renewal: RENEWAL_HINT,
    sessions: sessions.map((session, index) => ({
      bank: session.aspsp_name,
      country: session.aspsp_country,
      psu_type: session.psu_type,
      cached: true as const,
      cached_status: session.status,
      cached_valid_until: session.valid_until,
      ...(liveResults?.[index] ? {
        live_status: liveResults[index].live_status,
        live_valid_until: liveResults[index].live_valid_until,
        live_cached: liveResults[index].live_cached,
        live_error: liveResults[index].live_error,
        live_verified_at: liveResults[index].live_verified_at,
      } : {}),
      days_left_from_cached_valid_until: daysUntil(session.valid_until),
      last_live_verified_at: session.last_live_verified_at,
      last_live_result: session.last_live_result,
      renewal_due: session.renewal_due === 1,
      refreshes_used_today: session.refresh_count_date === today ? session.refresh_count_today : 0,
      refresh_budget_per_day: REFRESH_BUDGET_PER_DAY,
      rate_limit_backoff_until: session.backoff_until,
    })),
    add_bank: `To connect another bank, first link its accounts to the application in the Enable Banking Control Panel (Restricted access), then run '${AUTH_LINK_CMD}' on the operator machine.`,
    add_business: `To add business accounts, run '${AUTH_LINK_CMD}' with --psu=business on the operator machine and complete the bank login. The accounts must be linked to the application first.`,
  };
}

export function serializeMcpText(warning: string, data: unknown) {
  return { content: [{ type: "text" as const, text: warning + JSON.stringify(data, null, 2) }] };
}
