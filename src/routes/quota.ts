// ─── Quota / Usage readers (extracted from server.js) ─────
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';

export function readClaudeCreds() {
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
    } catch (e) { console.debug('[quota:codex] token read failed', e.message); }
    return null;
}

export async function fetchClaudeUsage(creds) {
    if (!creds?.token) return null;
    try {
        const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: { 'Authorization': `Bearer ${creds.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const windows = [];
        const labelMap = { five_hour: '5-hour', seven_day: '7-day', seven_day_sonnet: '7-day Sonnet', seven_day_opus: '7-day Opus' };
        for (const [key, label] of Object.entries(labelMap)) {
            if (data[key]?.utilization != null) {
                windows.push({ label, percent: Math.round(data[key].utilization), resetsAt: data[key].resets_at ?? null });
            }
        }
        return { account: creds.account, windows, raw: data };
    } catch { return null; }
}

export async function fetchCodexUsage(tokens) {
    if (!tokens) return null;
    try {
        const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id ?? '' },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const account = { email: data.email ?? null, plan: data.plan_type ?? null };
        const windows = [];
        if (data.rate_limit?.primary_window) {
            windows.push({ label: '5-hour', percent: data.rate_limit.primary_window.used_percent ?? 0, resetsAt: data.rate_limit.primary_window.reset_at ? new Date(data.rate_limit.primary_window.reset_at * 1000).toISOString() : null });
        }
        if (data.rate_limit?.secondary_window) {
            windows.push({ label: '7-day', percent: data.rate_limit.secondary_window.used_percent ?? 0, resetsAt: data.rate_limit.secondary_window.reset_at ? new Date(data.rate_limit.secondary_window.reset_at * 1000).toISOString() : null });
        }
        return { account, windows, raw: data };
    } catch { return null; }
}

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
