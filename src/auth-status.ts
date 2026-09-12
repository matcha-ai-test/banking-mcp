import type { Db } from "./db";
import { ExpiredSessionError, RateLimitError } from "./eb";
import type { EbClient } from "./eb";
import type { AuthStatusSessionRow } from "./types";

export const LIVE_VERIFY_COOLDOWN_MS = 15 * 60_000;

export interface LiveSessionResult {
  live_status: string | null;
  live_valid_until: string | null;
  live_error: string | null;
  live_cached: boolean;
  live_verified_at: string | null;
}

type StoredLiveResult = Pick<LiveSessionResult, "live_status" | "live_valid_until" | "live_error">;
const ERROR_CODES = new Set(["expired_session", "rate_limited", "session_verification_failed", "verification_in_progress"]);

function storedLiveResult(raw: string | null | undefined): StoredLiveResult {
  const empty = { live_status: null, live_valid_until: null, live_error: null };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    return {
      live_status: typeof value?.live_status === "string" ? value.live_status : null,
      live_valid_until: typeof value?.live_valid_until === "string" ? value.live_valid_until : null,
      live_error: ERROR_CODES.has(value?.live_error) ? value.live_error : null,
    };
  } catch {
    return empty;
  }
}

/** Cached by default. Verification never invokes any account fetch or sync path. */
export async function readAuthStatus(
  db: Db,
  createClient: () => Pick<EbClient, "getSession">,
  verify = false,
  nowMs = Date.now()
): Promise<{ sessions: AuthStatusSessionRow[]; liveResults?: LiveSessionResult[] }> {
  if (!verify) return { sessions: await db.allSessions(10) };

  // One request clock for every session, even when an earlier bank call is slow.
  const verifiedAt = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - LIVE_VERIFY_COOLDOWN_MS).toISOString();
  const sessions: AuthStatusSessionRow[] = [];
  const liveResults: LiveSessionResult[] = [];
  let client: Pick<EbClient, "getSession"> | undefined;
  for (const stored of await db.sessionsForVerification()) {
    const pending = { live_status: null, live_valid_until: null, live_error: "verification_in_progress" };
    const claimed = await db.claimSessionVerification(stored.id, verifiedAt, cutoff, JSON.stringify(pending));
    if (claimed) {
      let result: StoredLiveResult;
      try {
        client ??= createClient();
        const live = await client.getSession(stored.session_id);
        result = {
          live_status: typeof live.status === "string" ? live.status : null,
          live_valid_until: typeof live.access?.valid_until === "string" ? live.access.valid_until : null,
          live_error: null,
        };
      } catch (error) {
        result = {
          live_status: null,
          live_valid_until: null,
          live_error: error instanceof ExpiredSessionError ? "expired_session"
            : error instanceof RateLimitError ? "rate_limited" : "session_verification_failed",
        };
      }
      // Failed calls retain the claim, so their cooldown is also enforced.
      await db.setSessionVerificationResult(stored.id, verifiedAt, JSON.stringify(result));
    }
    // Return persisted state, including when completion lost its claim guard.
    const row = (await db.sessionsForVerification(stored.id))[0];
    if (!row) continue;
    const { id: _id, session_id: _sessionId, live_verify_claimed_at, live_verify_result, ...safeRow } = row;
    sessions.push(safeRow);
    liveResults.push({ ...storedLiveResult(live_verify_result), live_cached: !claimed,
      live_verified_at: live_verify_claimed_at ?? null });
  }
  return { sessions, liveResults };
}
