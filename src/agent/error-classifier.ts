// ─── Error Classification for Agent Exit ─────────────

import { isClaudeLikeCli } from './cli-helpers.js';

export interface ErrorClassification {
    is429: boolean;
    isAuth: boolean;
    isStall: boolean;
    isModelCapacity: boolean;
    isClaudeRateLimit: boolean;
    isTransientStartup: boolean;
    /** Transport-level failure (backend unreachable / connection dropped).
     *  Retryable like a 429: the request never completed, so re-running it
     *  repeats nothing. Auth failures are excluded — a locked keychain is not
     *  fixed by respawning. */
    isConnection: boolean;
    message: string;
}

/** Transport failures as the wrapped CLIs actually print them. `unavailable`
 *  is deliberately CLI-scoped (cursor's ConnectRPC status), not a bare word —
 *  audit note: matching the plain English word would misclassify ordinary
 *  model prose. */
const CONNECTION_ERROR_RE = /connection lost|failed to reconnect|connect_error|connecterror|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|rpc_unavailable|code = unavailable/i;
const KEYCHAIN_LOCKED_RE = /keychain is locked|login keychain/i;

export function classifyExitError(
    cli: string,
    code: number | null,
    stderrBuf: string,
    stallReason?: string,
    diagnosticText = '',
    /**
     * Whether this run already emitted assistant output. A "transient startup"
     * failure is only transient if nothing has happened yet: once output exists,
     * the run is past startup and re-running it would repeat work.
     */
    outputStarted = false,
): ErrorClassification {
    const combined = `${stderrBuf}\n${diagnosticText}`;
    const isModelCapacity = false;
    // Case-insensitive on purpose: cursor-agent prints
    // "RetriableError: [resource_exhausted]" in lowercase (observed live on
    // suji, 2026-08-24), which a cased includes() silently missed — those
    // turns died with exit 1 and no retry.
    const rawIs429 = /\b429\b/.test(combined)
        || /resource_exhausted/i.test(combined)
        || /too many requests/i.test(combined);
    // Claude Code owns its own rate-limit wait/retry behavior. Treating these
    // progress messages as Jaw-level 429 failures causes unnecessary retries or
    // fallback away from a request that Claude may still complete.
    const isClaudeRateLimit = rawIs429 && isClaudeLikeCli(cli);
    const is429 = rawIs429 && !isClaudeRateLimit;
    // Wrapper CLIs (e.g. claude-e) exit BEFORE the session starts on transient
    // upstream blips (rate-limit / 5xx) and mask the real reason as a generic
    // "exited before SessionStart" — cli-jaw never sees the child 429. Treat that
    // pre-session signature as a retryable transient. (#219)
    // The name promises "before work began", so the signature alone is not
    // enough: the same string can appear in output from a run that already
    // produced results.
    const isTransientStartup = !outputStarted && /exited before SessionStart/i.test(combined);
    const isAuth = combined.includes('auth') || combined.includes('credentials')
        || KEYCHAIN_LOCKED_RE.test(combined);
    const isConnection = !isAuth && CONNECTION_ERROR_RE.test(combined);
    const isStall = !!stallReason;

    let message = `${cli} 실행 실패 (exit ${code})`;
    if (isStall) message = `⏱️ 응답 없음 — ${stallReason}`;
    else if (isModelCapacity) message = '⚡ Gemini 모델 capacity 부족 — Auto로 임시 우회합니다';
    else if (is429) message = '⚡ API 용량 초과 (429)';
    else if (isAuth) message = '🔐 인증 오류 — CLI 로그인 상태를 확인해주세요';
    else if (isConnection) message = `🔌 ${cli} 연결 오류 — 재시도합니다`;
    else if (combined.trim()) message = combined.trim().slice(0, 200);

    return { is429, isAuth, isStall, isModelCapacity, isClaudeRateLimit, isTransientStartup, isConnection, message };
}

// Lives in its own leaf module so `core/db` can strip it without importing the
// exit classifier. Re-exported here because the callers that append it already
// import from this file (#405).
export { STALL_TRUNCATION_NOTICE, stripStallTruncationNotice } from './stall-notice.js';

/**
 * Should a turn that DID produce output say it was cut short?
 *
 * A watchdog kill with partial output lands in the output branch of the exit
 * handler, not the stall branch, so its reason never reached the channel: the
 * reply stopped mid-thought and read as the model trailing off (#405).
 *
 * `stallReason` alone, deliberately — not `stallReason && wasKilled`. The
 * watchdog callback sets `stallReason` and kills the process but never writes
 * `killReasons`, while `wasKilled` is computed purely from
 * `consumeKillReason()`, so `wasKilled` is false for exactly the case this
 * covers. `stallReason` has no other writer, which is what makes it enough.
 */
export function shouldAnnounceStallTruncation(input: {
    stallReason: string | null | undefined;
    wasSteer: boolean;
    mainManaged: boolean;
    internal: boolean;
}): boolean {
    // A user who pressed stop knows why it stopped; that is not a timeout.
    if (!input.stallReason) return false;
    if (input.wasSteer) return false;
    // Sub-agent and internal runs have no reader to tell.
    return input.mainManaged && !input.internal;
}
