// ─── Error Classification for Agent Exit ─────────────

import { isClaudeLikeCli } from './cli-helpers.js';

export interface ErrorClassification {
    is429: boolean;
    isAuth: boolean;
    isStall: boolean;
    isModelCapacity: boolean;
    isClaudeRateLimit: boolean;
    isTransientStartup: boolean;
    message: string;
}

export function classifyExitError(
    cli: string,
    code: number | null,
    stderrBuf: string,
    stallReason?: string,
    diagnosticText = '',
): ErrorClassification {
    const combined = `${stderrBuf}\n${diagnosticText}`;
    const isModelCapacity = false;
    const rawIs429 = /\b429\b/.test(combined)
        || combined.includes('RESOURCE_EXHAUSTED')
        || combined.includes('Too Many Requests');
    // Claude Code owns its own rate-limit wait/retry behavior. Treating these
    // progress messages as Jaw-level 429 failures causes unnecessary retries or
    // fallback away from a request that Claude may still complete.
    const isClaudeRateLimit = rawIs429 && isClaudeLikeCli(cli);
    const is429 = rawIs429 && !isClaudeRateLimit;
    // Wrapper CLIs (e.g. claude-e) exit BEFORE the session starts on transient
    // upstream blips (rate-limit / 5xx) and mask the real reason as a generic
    // "exited before SessionStart" — cli-jaw never sees the child 429. Treat that
    // pre-session signature as a retryable transient. (#219)
    const isTransientStartup = /exited before SessionStart/i.test(combined);
    const isAuth = combined.includes('auth') || combined.includes('credentials');
    const isStall = !!stallReason;

    let message = `${cli} 실행 실패 (exit ${code})`;
    if (isStall) message = `⏱️ 응답 없음 — ${stallReason}`;
    else if (isModelCapacity) message = '⚡ Gemini 모델 capacity 부족 — Auto로 임시 우회합니다';
    else if (is429) message = '⚡ API 용량 초과 (429)';
    else if (isAuth) message = '🔐 인증 오류 — CLI 로그인 상태를 확인해주세요';
    else if (combined.trim()) message = combined.trim().slice(0, 200);

    return { is429, isAuth, isStall, isModelCapacity, isClaudeRateLimit, isTransientStartup, message };
}
