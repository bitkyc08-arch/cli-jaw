// Resume/heartbeat/bucket decision helpers — pure functions, no spawn state mutation.

import { normalizeModelForCli } from '../../core/config.js';

// ─── ACP Heartbeat Helper ────────────────────────────
// Pure function for conditional heartbeat gating.
// "visible" = WebUI + Telegram common baseline. 💭 is WebUI-only
// (bot.ts:337 hides it), so it's NOT counted as visible.
const DEFAULT_HEARTBEAT_GATE_MS = 20_000;

export function shouldEmitHeartbeat(
    lastVisibleTs: number,
    heartbeatSent: boolean,
    gateMs: number = DEFAULT_HEARTBEAT_GATE_MS,
    now: number = Date.now(),
): boolean {
    if (heartbeatSent) return false;
    return (now - lastVisibleTs) > gateMs;
}

export function shouldResumeBucketSession(
    cli: string,
    requestedModel: string,
    bucketModel: string | null | undefined,
    requestedResumeKey?: string | null,
    bucketResumeKey?: string | null,
    bucketUpdatedAt?: string | number | null,
    nowMs: number = Date.now(),
    effectiveProvider?: string | null,
): boolean {
    if (cli === 'copilot' && bucketModel) {
        return normalizeModelForCli(cli, requestedModel) === normalizeModelForCli(cli, bucketModel);
    }
    if (cli === 'cursor') {
        if (!bucketModel) return false;
        return normalizeModelForCli(cli, requestedModel) === normalizeModelForCli(cli, bucketModel);
    }
    if (cli === 'kiro-code' || (cli === 'ai-e' && effectiveProvider === 'kiro')) {
        if (!bucketModel) return false;
        return normalizeModelForCli('kiro-code', requestedModel) === normalizeModelForCli('kiro-code', bucketModel);
    }
    if (cli === 'opencode' && requestedResumeKey) {
        return requestedResumeKey === (bucketResumeKey ?? null);
    }
    if (cli === 'agy') {
        if (!bucketModel) return false;
        if (isExpiredBucket(bucketUpdatedAt, AGY_RESUME_TTL_MS, nowMs)) return false;
        return true;
    }
    return true;
}

export const AGY_RESUME_TTL_MS = 72 * 60 * 60 * 1000;


function parseBucketUpdatedAt(value: string | number | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 10_000_000_000 ? value * 1000 : value;
    }
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed) ? parsed : null;
}

function isExpiredBucket(value: string | number | null | undefined, ttlMs: number, nowMs: number): boolean {
    const updatedAtMs = parseBucketUpdatedAt(value);
    if (updatedAtMs === null) return true;
    return nowMs - updatedAtMs > ttlMs;
}
