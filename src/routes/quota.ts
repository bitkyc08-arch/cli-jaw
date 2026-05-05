// ─── Quota / Usage readers (extracted from server.js) ─────
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { resolveHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';

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

interface GeminiOAuthCreds {
    access_token?: string;
    refresh_token?: string;
    expiry_date?: number;
    token_type?: string;
    id_token?: string;
}

interface GeminiQuotaAccount {
    token: string;
    refreshToken?: string;
    expiresAt?: number;
    account: { email: string | null };
}

type ClaudeCredsSource =
    | 'cloud-provider-env'
    | 'auth-token-env'
    | 'api-key-env'
    | 'oauth-env'
    | 'macos-keychain'
    | 'credentials-json';

interface ClaudeCreds {
    token?: string;
    source: ClaudeCredsSource;
    quotaCapable: boolean;
    account: { type: string; tier: string | null };
}

const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal';
const GEMINI_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GEMINI_TOKEN_EXPIRY_SKEW_MS = 60_000;
const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

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

function expandClaudeConfigDir(configDir = process.env["CLAUDE_CONFIG_DIR"], homeDir = os.homedir()): string {
    if (configDir?.trim()) {
        return resolveHomePath(configDir, homeDir);
    }
    return join(homeDir, '.claude');
}

export function getClaudeCredentialsPath(configDir = process.env["CLAUDE_CONFIG_DIR"], homeDir = os.homedir()): string {
    return join(expandClaudeConfigDir(configDir, homeDir), CLAUDE_CREDENTIALS_FILE);
}

function readClaudeOAuthPayload(raw: string, source: ClaudeCredsSource): ClaudeCreds | null {
    try {
        const parsed = JSON.parse(raw);
        const oauth = parsed?.claudeAiOauth ?? parsed?.oauth ?? parsed;
        const accessToken = oauth?.accessToken ?? oauth?.access_token;
        if (typeof accessToken !== 'string' || !accessToken.trim()) return null;
        return {
            token: accessToken,
            source,
            quotaCapable: true,
            account: {
                type: oauth?.subscriptionType ?? oauth?.subscription_type ?? source,
                tier: oauth?.rateLimitTier ?? oauth?.rate_limit_tier ?? null,
            },
        };
    } catch { return null; }
}

function readClaudeCredsFromKeychain(): ClaudeCreds | null {
    try {
        const raw = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w',
            { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString().trim();
        return readClaudeOAuthPayload(raw, 'macos-keychain');
    } catch { return null; }
}

function readClaudeCredsFromFile(): ClaudeCreds | null {
    try {
        const raw = fs.readFileSync(getClaudeCredentialsPath(), 'utf8');
        return readClaudeOAuthPayload(raw, 'credentials-json');
    } catch { return null; }
}

// Cross-platform Claude auth detection.
// macOS stores subscription OAuth in Keychain; Linux/Windows/WSL store it in
// ~/.claude/.credentials.json, or under $CLAUDE_CONFIG_DIR when configured.
export function readClaudeCreds(): ClaudeCreds | null {
    if (process.env["CLAUDE_CODE_USE_BEDROCK"] || process.env["CLAUDE_CODE_USE_VERTEX"] || process.env["CLAUDE_CODE_USE_FOUNDRY"]) {
        return { source: 'cloud-provider-env', quotaCapable: false, account: { type: 'cloud-provider', tier: null } };
    }
    if (process.env["ANTHROPIC_AUTH_TOKEN"]) {
        return { token: process.env["ANTHROPIC_AUTH_TOKEN"], source: 'auth-token-env', quotaCapable: false, account: { type: 'auth-token', tier: null } };
    }
    if (process.env["ANTHROPIC_API_KEY"]) {
        return { token: process.env["ANTHROPIC_API_KEY"], source: 'api-key-env', quotaCapable: false, account: { type: 'api-key', tier: null } };
    }
    if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
        return { token: process.env["CLAUDE_CODE_OAUTH_TOKEN"], source: 'oauth-env', quotaCapable: true, account: { type: 'oauth-token', tier: null } };
    }
    if (process.env["CLAUDE_CONFIG_DIR"]) {
        return readClaudeCredsFromFile();
    }
    if (process.platform === 'darwin') {
        const keychainCreds = readClaudeCredsFromKeychain();
        if (keychainCreds) return keychainCreds;
    }
    return readClaudeCredsFromFile();
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

interface ClaudeCredsLike { quotaCapable?: boolean; account?: unknown; source?: string; token?: string }
interface CodexTokensLike { access_token?: string; account_id?: string }

export async function fetchClaudeUsage(creds: ClaudeCredsLike | null | undefined) {
    if (!creds) return null;
    if (creds.quotaCapable === false) {
        return { authenticated: true, account: creds.account, windows: [], source: creds.source };
    }
    if (!creds.token) return null;
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
        const data = await resp.json() as Record<string, { utilization?: number; resets_at?: string | null } | undefined>;
        const windows = [];
        const labelMap = { five_hour: '5-hour', seven_day: '7-day', seven_day_sonnet: '7-day Sonnet', seven_day_opus: '7-day Opus' };
        for (const [key, label] of Object.entries(labelMap)) {
            const w = data[key];
            if (w?.utilization != null) {
                windows.push({ label, percent: Math.round(w.utilization), resetsAt: w.resets_at ?? null });
            }
        }
        const result = { account: creds.account, windows, raw: data };
        _claudeUsageCache = { data: result, ts: Date.now() };
        return result;
    } catch { return { error: true }; }
}

export async function fetchCodexUsage(tokens: CodexTokensLike | null | undefined) {
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
        const account = { email: data["email"] ?? null, plan: data["plan_type"] ?? null };
        const windows = [];
        if (data["rate_limit"]?.primary_window) {
            windows.push({ label: '5-hour', percent: data["rate_limit"].primary_window.used_percent ?? 0, resetsAt: data["rate_limit"].primary_window.reset_at ? new Date(data["rate_limit"].primary_window.reset_at * 1000).toISOString() : null });
        }
        if (data["rate_limit"]?.secondary_window) {
            windows.push({ label: '7-day', percent: data["rate_limit"].secondary_window.used_percent ?? 0, resetsAt: data["rate_limit"].secondary_window.reset_at ? new Date(data["rate_limit"].secondary_window.reset_at * 1000).toISOString() : null });
        }
        return { account, windows, raw: data };
    } catch { return { error: true }; }
}

// Cross-platform: reads Gemini OAuth creds from ~/.gemini/oauth_creds.json.
// Returns null if file doesn't exist (= not authenticated).
export function readGeminiAccount() {
    try {
        const credsPath = join(os.homedir(), '.gemini', 'oauth_creds.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as GeminiOAuthCreds;
        const token = typeof creds.access_token === 'string' ? creds.access_token : '';
        const idTokenPayload = typeof creds.id_token === 'string' ? creds.id_token.split('.')[1] : undefined;
        if (token && idTokenPayload) {
            const payload = JSON.parse(Buffer.from(idTokenPayload, 'base64url').toString());
            return stripUndefined({
                token,
                refreshToken: typeof creds.refresh_token === 'string' ? creds.refresh_token : undefined,
                expiresAt: typeof creds.expiry_date === 'number' ? creds.expiry_date : undefined,
                account: { email: payload.email ?? null },
            });
        }
    } catch { /* expected: gemini creds may not exist */ }
    return null;
}

async function refreshGeminiAccessToken(account: GeminiQuotaAccount): Promise<string | null> {
    if (!account.refreshToken) return null;
    const clientId = process.env["GEMINI_OAUTH_CLIENT_ID"];
    const clientSecret = process.env["GEMINI_OAUTH_CLIENT_SECRET"];
    if (!clientId || !clientSecret) return null;
    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
    });
    const resp = await fetch(GEMINI_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { access_token?: string };
    return typeof data.access_token === 'string' ? data.access_token : null;
}

async function getGeminiAccessToken(account: GeminiQuotaAccount): Promise<string | null> {
    const expiresAt = account.expiresAt ?? 0;
    if (account.token && (!expiresAt || expiresAt - Date.now() > GEMINI_TOKEN_EXPIRY_SKEW_MS)) {
        return account.token;
    }
    return refreshGeminiAccessToken(account);
}

async function geminiCodeAssistPost<T>(method: string, token: string, body: object): Promise<T> {
    const resp = await fetch(`${GEMINI_CODE_ASSIST_ENDPOINT}:${method}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) throw new Error('auth');
        throw new Error(`status_${resp.status}`);
    }
    return resp.json() as Promise<T>;
}

export async function fetchGeminiUsage(account: GeminiQuotaAccount | null) {
    if (!account) return null;
    try {
        const token = await getGeminiAccessToken(account);
        if (!token) return { authenticated: false };
        const metadata = {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
        };
        const loadRes = await geminiCodeAssistPost<{
            cloudaicompanionProject?: string;
        }>('loadCodeAssist', token, {
            metadata,
        });
        const project = loadRes.cloudaicompanionProject;
        if (!project) return { account: account.account, windows: [] };
        const quota = await geminiCodeAssistPost<{ buckets?: GeminiQuotaBucket[] }>(
            'retrieveUserQuota',
            token,
            { project },
        );
        return {
            account: account.account,
            windows: normalizeGeminiQuotaBuckets(quota.buckets ?? []),
            raw: quota,
        };
    } catch (e: unknown) {
        if ((e as Error).message === 'auth') return { authenticated: false };
        return { account: account.account, windows: [], error: true };
    }
}
