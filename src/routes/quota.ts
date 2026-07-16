// ─── Quota / Usage readers (extracted from server.js) ─────
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { resolveHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';

interface GrokSessionUsage {
    sourcePath: string;
    updatedAt: string;
    turnCount?: number;
    userMessageCount?: number;
    assistantMessageCount?: number;
    contextTokensUsed?: number;
    contextWindowTokens?: number;
    contextWindowUsage?: number;
    toolCallCount?: number;
    primaryModelId?: string;
    modelsUsed?: string[];
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

const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

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
    const now = Date.now();
    if (claudeKeychainCredsCache && now - claudeKeychainCredsCache.ts < CLAUDE_KEYCHAIN_CACHE_TTL_MS) {
        return claudeKeychainCredsCache.creds;
    }
    try {
        const raw = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w',
            { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString().trim();
        const creds = readClaudeOAuthPayload(raw, 'macos-keychain');
        // Cache successful non-null reads only. Caching null/failure for 60s
        // would let a transient Keychain miss or locked prompt hide a valid
        // credential until TTL expiry.
        if (creds) claudeKeychainCredsCache = { creds, ts: now };
        return creds;
    } catch {
        return null; // best-effort: transient Keychain failure is not cached
    }
}

const CLAUDE_KEYCHAIN_CACHE_TTL_MS = 60_000;
let claudeKeychainCredsCache: { creds: ClaudeCreds; ts: number } | null = null;

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
        const data = await resp.json() as {
            email?: string | null;
            plan_type?: string | null;
            rate_limit?: {
                primary_window?: { used_percent?: number; reset_at?: number };
                secondary_window?: { used_percent?: number; reset_at?: number };
            };
        };
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

function findLatestGrokSignalsFile(homeDir = os.homedir()): string | null {
    const sessionsDir = join(homeDir, '.grok', 'sessions');
    let latest: { path: string; mtimeMs: number } | null = null;
    const stack = [sessionsDir];
    let visited = 0;
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (++visited > 5000) return latest?.path ?? null;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile() || entry.name !== 'signals.json') continue;
            try {
                const stat = fs.statSync(full);
                if (!latest || stat.mtimeMs > latest.mtimeMs) {
                    latest = { path: full, mtimeMs: stat.mtimeMs };
                }
            } catch { /* best effort */ }
        }
    }
    return latest?.path ?? null;
}

export function readLatestGrokSessionUsage(homeDir = os.homedir()): GrokSessionUsage | null {
    const signalsPath = findLatestGrokSignalsFile(homeDir);
    if (!signalsPath) return null;
    try {
        const stat = fs.statSync(signalsPath);
        const raw = JSON.parse(fs.readFileSync(signalsPath, 'utf8')) as Record<string, unknown>;
        const numberField = (key: string): number | undefined =>
            typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
        const stringField = (key: string): string | undefined =>
            typeof raw[key] === 'string' && raw[key].trim() ? raw[key] as string : undefined;
        const stringArrayField = (key: string): string[] | undefined =>
            Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
        return stripUndefined({
            sourcePath: signalsPath,
            updatedAt: stat.mtime.toISOString(),
            turnCount: numberField('turnCount'),
            userMessageCount: numberField('userMessageCount'),
            assistantMessageCount: numberField('assistantMessageCount'),
            contextTokensUsed: numberField('contextTokensUsed'),
            contextWindowTokens: numberField('contextWindowTokens'),
            contextWindowUsage: numberField('contextWindowUsage'),
            toolCallCount: numberField('toolCallCount'),
            primaryModelId: stringField('primaryModelId'),
            modelsUsed: stringArrayField('modelsUsed'),
        }) as GrokSessionUsage;
    } catch {
        return null;
    }
}

interface GrokBillingData {
    tier: string;
    limit: number;
    used: number;
    percent: number;
    limitUsd: number;
    usedUsd: number;
    periodLabel: string;
    periodStart?: string | null;
    periodEnd: string;
    email: string | null;
    source: string;
}

const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const GROK_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user';
const GROK_CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

function grokTierFromLimit(val: number): string {
    if (val >= 150_000) return 'SuperGrok Heavy';
    if (val >= 15_000) return 'SuperGrok';
    return `SuperGrok (${val} val)`;
}

interface GrokTokenCandidate {
    token: string;
    source: string;
    email: string | null;
    authMode: string | null;
    issuer: string | null;
    userId: string | null;
}

function readGrokTokenCandidates(homeDir = os.homedir()): GrokTokenCandidate[] {
    const candidates: GrokTokenCandidate[] = [];
    try {
        const authPath = join(homeDir, '.grok', 'auth.json');
        const data = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
        const entries = Object.entries(data)
            .filter(([, entry]) => entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['key'] === 'string')
            .map(([scope, entry]) => {
                const obj = entry as Record<string, unknown>;
                return {
                    token: obj['key'] as string,
                    source: scope.startsWith('https://auth.x.ai::') ? 'grok:auth-json-oidc' : 'grok:auth-json',
                    email: typeof obj['email'] === 'string' ? obj['email'] as string : null,
                    authMode: typeof obj['auth_mode'] === 'string' ? obj['auth_mode'] as string : null,
                    issuer: typeof obj['oidc_issuer'] === 'string' ? obj['oidc_issuer'] as string : null,
                    userId: typeof obj['user_id'] === 'string' ? obj['user_id'] as string : null,
                    priority: scope.startsWith('https://auth.x.ai::') ? 0 : 1,
                };
            })
            .sort((a, b) => a.priority - b.priority);
        for (const entry of entries) candidates.push({
            token: entry.token,
            source: entry.source,
            email: entry.email,
            authMode: entry.authMode,
            issuer: entry.issuer,
            userId: entry.userId,
        });
    } catch { /* best effort */ }
    try {
        const authPath = join(homeDir, '.progrok', 'auth.json');
        const data = JSON.parse(fs.readFileSync(authPath, 'utf8')) as { accessToken?: string };
        if (typeof data.accessToken === 'string' && data.accessToken.trim()) {
            candidates.push({
                token: data.accessToken,
                source: 'progrok:auth-json',
                email: null,
                authMode: null,
                issuer: null,
                userId: null,
            });
        }
    } catch { /* best effort */ }
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        if (!candidate.token || seen.has(candidate.token)) return false;
        seen.add(candidate.token);
        return true;
    });
}

function isGrokWeeklyCandidate(candidate: GrokTokenCandidate): boolean {
    return (candidate.authMode === 'oidc' || candidate.authMode === 'external')
        && candidate.issuer === 'https://auth.x.ai'
        && Boolean(candidate.userId?.trim());
}

function readGrokClientVersion(homeDir = os.homedir(), grokBinary = 'grok'): string | null {
    for (const [file, field] of [['version.json', 'version'], ['models_cache.json', 'grok_version']] as const) {
        try {
            const data = JSON.parse(fs.readFileSync(join(homeDir, '.grok', file), 'utf8')) as Record<string, unknown>;
            const value = data[field];
            if (typeof value === 'string' && value.trim()) return value.trim();
        } catch { /* best effort */ }
    }
    try {
        const output = execFileSync(grokBinary, ['version'], {
            encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
    } catch { return null; }
}

export function inspectGrokWeeklyEligibility(homeDir = os.homedir(), grokBinary = 'grok') {
    const candidates = readGrokTokenCandidates(homeDir);
    const xaiCandidates = candidates.filter((candidate) =>
        (candidate.authMode === 'oidc' || candidate.authMode === 'external')
        && candidate.issuer === 'https://auth.x.ai');
    const eligibleCandidates = xaiCandidates.filter(isGrokWeeklyCandidate);
    const clientVersion = readGrokClientVersion(homeDir, grokBinary);
    const reason = candidates.length === 0 ? 'no-auth'
        : xaiCandidates.length === 0 ? 'no-xai-auth'
            : eligibleCandidates.length === 0 ? 'missing-user-id'
                : !clientVersion ? 'no-version'
                    : 'ok';
    return {
        eligible: reason === 'ok',
        reason,
        candidateCount: eligibleCandidates.length,
        clientVersion,
    };
}

export function parseGrokCreditsResponse(value: unknown): Pick<GrokBillingData, 'percent' | 'periodEnd' | 'periodLabel' | 'source'> | null {
    if (!value || typeof value !== 'object') return null;
    const config = (value as Record<string, unknown>)['config'];
    if (!config || typeof config !== 'object') return null;
    const currentPeriod = (config as Record<string, unknown>)['currentPeriod'];
    if (!currentPeriod || typeof currentPeriod !== 'object') return null;
    const period = currentPeriod as Record<string, unknown>;
    const end = period['end'];
    if (period['type'] !== 'USAGE_PERIOD_TYPE_WEEKLY' || typeof end !== 'string' || !Number.isFinite(Date.parse(end))) return null;
    const rawPercent = (config as Record<string, unknown>)['creditUsagePercent'];
    if (rawPercent !== undefined && (typeof rawPercent !== 'number' || !Number.isFinite(rawPercent))) return null;
    return {
        percent: Math.round(Math.min(100, Math.max(0, rawPercent as number | undefined ?? 0))),
        periodEnd: end,
        periodLabel: 'weekly',
        source: 'grok:grok-build-billing-credits-rest',
    };
}

async function fetchGrokWeeklyCredits(candidate: GrokTokenCandidate, clientVersion: string): Promise<Pick<GrokBillingData, 'percent' | 'periodEnd' | 'periodLabel' | 'source'> | null> {
    try {
        const resp = await fetch(GROK_CREDITS_URL, {
            headers: {
                'Authorization': `Bearer ${candidate.token}`,
                'X-XAI-Token-Auth': 'xai-grok-cli',
                'x-authenticateresponse': 'authenticate-response',
                'x-userid': candidate.userId!,
                'x-grok-client-version': clientVersion,
                'x-grok-client-mode': 'headless',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        return parseGrokCreditsResponse(await resp.json());
    } catch { return null; }
}

export async function fetchGrokBilling(homeDir = os.homedir(), grokBinary = 'grok'): Promise<GrokBillingData | null> {
    const tokens = readGrokTokenCandidates(homeDir);
    if (!tokens.length) return null;
    const clientVersion = readGrokClientVersion(homeDir, grokBinary);
    if (clientVersion) {
        for (const candidate of tokens.filter(isGrokWeeklyCandidate)) {
            const weekly = await fetchGrokWeeklyCredits(candidate, clientVersion);
            if (weekly) {
                return {
                    tier: 'SuperGrok',
                    limit: 100,
                    used: weekly.percent,
                    percent: weekly.percent,
                    limitUsd: 0,
                    usedUsd: 0,
                    periodLabel: weekly.periodLabel,
                    periodEnd: weekly.periodEnd,
                    email: candidate.email ?? null,
                    source: weekly.source,
                };
            }
        }
    }
    for (const candidate of tokens) {
        try {
            const headers = { Authorization: `Bearer ${candidate.token}` };
            const [billingRes, userRes] = await Promise.allSettled([
                fetch(GROK_BILLING_URL, { headers, signal: AbortSignal.timeout(8000) }),
                fetch(GROK_USER_URL, { headers, signal: AbortSignal.timeout(5000) }),
            ]);
            if (billingRes.status !== 'fulfilled' || !billingRes.value.ok) continue;
            const billing = (await billingRes.value.json() as {
                config: { monthlyLimit: { val: number }; used: { val: number }; billingPeriodStart?: string; billingPeriodEnd: string };
            }).config;
            const limit = billing.monthlyLimit.val;
            const used = billing.used.val;
            let email: string | null = candidate.email ?? null;
            if (userRes.status === 'fulfilled' && userRes.value.ok) {
                const user = await userRes.value.json() as { email?: string };
                email = user.email ?? email;
            }
            return {
                tier: grokTierFromLimit(limit),
                limit, used,
                percent: limit > 0 ? Math.round((used / limit) * 100) : 0,
                limitUsd: limit / 100,
                usedUsd: used / 100,
                periodLabel: 'monthly',
                periodStart: billing.billingPeriodStart ?? null,
                periodEnd: billing.billingPeriodEnd,
                email,
                source: candidate.source === 'progrok:auth-json' ? 'progrok:billing-api' : 'grok:cli-chat-proxy-billing-api',
            };
        } catch { /* try the next credential */ }
    }
    return null;
}

export async function fetchGrokStatus(binary = 'grok') {
    let authenticated = false;
    let source = 'none';
    try {
        const out = execFileSync(binary, ['models'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        authenticated = out.includes('Available models') || out.includes('grok-build');
        source = authenticated ? 'grok models' : 'none';
    } catch { /* grok CLI may be missing or logged out */ }
    const billing = await fetchGrokBilling();
    const hasBilling = billing != null;
    return stripUndefined({
        authenticated: authenticated || hasBilling,
        quotaCapable: hasBilling,
        quotaSource: hasBilling ? billing!.source : 'not-exposed-by-grok-cli',
        sessionUsageCapable: true,
        displayTier: billing?.tier || 'Grok',
        account: {
            type: 'grok.com',
            tier: billing?.tier || null,
            email: billing?.email || null,
        },
        source,
        windows: hasBilling ? [{
            label: billing!.periodLabel,
            percent: billing!.percent,
            resetsAt: billing!.periodEnd,
        }] : [],
        billing: billing ?? undefined,
        sessionUsage: readLatestGrokSessionUsage() ?? undefined,
    });
}
