// ─── Quota / Usage readers (extracted from server.js) ─────
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';

export interface GeminiQuotaBucket {
    remainingFraction?: number;
    resetTime?: string;
    modelId?: string;
}

export interface GeminiQuotaWindow {
    label: 'F' | 'P';
    percent: number;
    resetsAt?: string | null;
    modelId: string;
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export function classifyGeminiQuotaTier(modelId: string): 'pro' | 'flash' | 'flash-lite' | null {
    if (modelId.includes('flash-lite')) return 'flash-lite';
    if (modelId.includes('pro')) return 'pro';
    if (modelId.includes('flash')) return 'flash';
    return null;
}

export function normalizeGeminiQuotaBuckets(buckets: GeminiQuotaBucket[]): GeminiQuotaWindow[] {
    const selected = new Map<'flash' | 'pro', GeminiQuotaWindow & { remainingFraction: number }>();

    for (const bucket of buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;
        const tier = classifyGeminiQuotaTier(bucket.modelId);
        if (tier !== 'flash' && tier !== 'pro') continue;

        const remainingFraction = Math.max(0, Math.min(1, bucket.remainingFraction));
        const percent = clampPercent(Math.round((1 - remainingFraction) * 100));
        const existing = selected.get(tier);
        if (existing && remainingFraction >= existing.remainingFraction) continue;

        selected.set(tier, {
            label: tier === 'pro' ? 'P' : 'F',
            percent,
            resetsAt: bucket.resetTime ?? null,
            modelId: bucket.modelId,
            remainingFraction,
        });
    }

    const order: Array<'flash' | 'pro'> = ['flash', 'pro'];
    return order.flatMap((tier) => {
        const window = selected.get(tier);
        if (!window) return [];
        const { remainingFraction: _remainingFraction, ...publicWindow } = window;
        return [publicWindow];
    });
}

// macOS-only: reads Claude Code OAuth token from system keychain.
// On Linux/WSL: returns null → classified as { authenticated: false } by /api/quota.
export function readClaudeCreds() {
    if (process.platform !== 'darwin') return null;
    try {
        const raw = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w',
            { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString().trim();
        const oauth = JSON.parse(raw)?.claudeAiOauth;
        if (!oauth?.accessToken) return null;
        return {
            token: oauth.accessToken,
            account: { type: oauth.subscriptionType ?? 'unknown', tier: oauth.rateLimitTier ?? null },
        };
    } catch { return null; }
}

export function readCodexTokens() {
    try {
        const authPath = join(os.homedir(), '.codex', 'auth.json');
        const j = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        if (j?.tokens?.access_token) return { access_token: j.tokens.access_token, account_id: j.tokens.account_id ?? '' };
    } catch (e: unknown) { console.debug('[quota:codex] token read failed', (e as Error).message); }
    return null;
}

let _claudeUsageCache: { data: Record<string, unknown>; ts: number } | null = null;
const CLAUDE_CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function fetchClaudeUsage(creds: any) {
    if (!creds?.token) return null;
    try {
        const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: { 'Authorization': `Bearer ${creds.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) return { authenticated: false };
            if (resp.status === 429) {
                if (_claudeUsageCache && Date.now() - _claudeUsageCache.ts < CLAUDE_CACHE_TTL) {
                    return { ..._claudeUsageCache.data, cached: true };
                }
                return {
                    account: creds.account,
                    windows: [{ label: '5-hour', percent: 100, resetsAt: null }],
                    error: true, reason: 'rate_limited',
                };
            }
            return { error: true };
        }
        const data = await resp.json() as Record<string, any>;
        const windows = [];
        const labelMap = { five_hour: '5-hour', seven_day: '7-day', seven_day_sonnet: '7-day Sonnet', seven_day_opus: '7-day Opus' };
        for (const [key, label] of Object.entries(labelMap)) {
            if (data[key]?.utilization != null) {
                windows.push({ label, percent: Math.round(data[key].utilization), resetsAt: data[key].resets_at ?? null });
            }
        }
        const result = { account: creds.account, windows, raw: data };
        _claudeUsageCache = { data: result, ts: Date.now() };
        return result;
    } catch { return { error: true }; }
}

export async function fetchCodexUsage(tokens: any) {
    if (!tokens) return null;
    try {
        const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id ?? '' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) return { authenticated: false };
            return { error: true };
        }
        const data = await resp.json() as Record<string, any>;
        const account = { email: data.email ?? null, plan: data.plan_type ?? null };
        const windows = [];
        if (data.rate_limit?.primary_window) {
            windows.push({ label: '5-hour', percent: data.rate_limit.primary_window.used_percent ?? 0, resetsAt: data.rate_limit.primary_window.reset_at ? new Date(data.rate_limit.primary_window.reset_at * 1000).toISOString() : null });
        }
        if (data.rate_limit?.secondary_window) {
            windows.push({ label: '7-day', percent: data.rate_limit.secondary_window.used_percent ?? 0, resetsAt: data.rate_limit.secondary_window.reset_at ? new Date(data.rate_limit.secondary_window.reset_at * 1000).toISOString() : null });
        }
        return { account, windows, raw: data };
    } catch { return { error: true }; }
}

// Cross-platform: reads Gemini OAuth creds from ~/.gemini/oauth_creds.json.
// Returns null if file doesn't exist (= not authenticated).
export function readGeminiAccount() {
    try {
        const credsPath = join(os.homedir(), '.gemini', 'oauth_creds.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (creds?.id_token) {
            const payload = JSON.parse(Buffer.from(creds.id_token.split('.')[1], 'base64url').toString());
            return { account: { email: payload.email ?? null }, windows: [] };
        }
    } catch { /* expected: gemini creds may not exist */ }
    return null;
}
