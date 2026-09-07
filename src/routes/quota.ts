// ─── Quota / Usage readers (extracted from server.js) ─────
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { resolveHomePath } from '../core/path-expand.js';
import { probeGrokModels } from '../core/probe-exec.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { createHash } from 'node:crypto';
import { parseClaudeUsageWindows, parseCodexUsageWindows, type NativeUsageWindows } from './quota-native-window.js';
import { asQuotaRecord, quotaNumber, quotaPercent, quotaResetIso, readQuotaBytes, readQuotaJson } from './quota-wire.js';

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

export function getCodexCredentialsPath(configDir = process.env['CODEX_HOME'], homeDir = os.homedir()): string {
    return join(configDir?.trim() ? resolveHomePath(configDir, homeDir) : join(homeDir, '.codex'), 'auth.json');
}
export function readCodexTokens() {
    try {
        const j = JSON.parse(fs.readFileSync(getCodexCredentialsPath(), 'utf8'));
        const access = j?.tokens?.access_token;
        const account = j?.tokens?.account_id;
        if (typeof access !== 'string' || !access.trim()) return null;
        return { access_token: access, account_id: typeof account === 'string' ? account : '' };
    } catch {
        // Native credential read failure is status-only; never log JSON parse excerpts.
        return null;
    }
}

interface ClaudeCredsLike { quotaCapable?: boolean; account?: unknown; source?: string; token?: string }
interface CodexTokensLike { access_token?: string; account_id?: string }
type ClaudeSnapshot = NativeUsageWindows & { raw: unknown };
type ClaudeProbe = ClaudeSnapshot | { authenticated: false } | { error: true; reason?: string; windows?: never[] };
const CLAUDE_FRESH_TTL_MS = 30_000;
const CLAUDE_FALLBACK_TTL_MS = 5 * 60_000;
const CLAUDE_CACHE_MAX_ENTRIES = 16;
const claudeUsageCache = new Map<string, { data: ClaudeSnapshot; ts: number }>();
const claudeUsageInflight = new Map<string, Promise<ClaudeProbe>>();
function pruneClaudeUsageCache(now: number): void {
    for (const [key, entry] of claudeUsageCache) {
        if (now - entry.ts >= CLAUDE_FALLBACK_TTL_MS) claudeUsageCache.delete(key);
    }
    while (claudeUsageCache.size > CLAUDE_CACHE_MAX_ENTRIES) {
        const key = claudeUsageCache.keys().next().value;
        if (key === undefined) break;
        claudeUsageCache.delete(key);
    }
}
export async function fetchClaudeUsage(creds: ClaudeCredsLike | null | undefined) {
    if (!creds) return null;
    if (creds.quotaCapable === false) {
        return { authenticated: true, account: creds.account, windows: [], source: creds.source };
    }
    if (typeof creds.token !== 'string' || !creds.token.trim()) return null;
    const token = creds.token;
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    pruneClaudeUsageCache(now);
    const cached = claudeUsageCache.get(key);
    if (cached && now - cached.ts < CLAUDE_FRESH_TTL_MS) {
        return { ...structuredClone(cached.data), account: creds.account, cached: true };
    }
    let pending = claudeUsageInflight.get(key);
    if (!pending) {
        const probe = async (): Promise<ClaudeProbe> => {
            try {
                const signal = AbortSignal.timeout(8000);
                const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
                    redirect: 'error',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json',
                        'User-Agent': 'claude-cli/2.1.63 (external, cli)',
                        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05',
                        'Authorization': `Bearer ${token}`,
                    }, signal,
                });
                if (!resp.ok) {
                    try { void resp.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
                    if (resp.status === 401 || resp.status === 403) {
                        claudeUsageCache.delete(key);
                        return { authenticated: false };
                    }
                    if (resp.status === 429) return { error: true, reason: 'rate_limited', windows: [] };
                    return { error: true };
                }
                const raw = await readQuotaJson(resp);
                const parsed = parseClaudeUsageWindows(raw);
                if (!parsed) return { error: true };
                const result = { ...parsed, raw };
                claudeUsageCache.set(key, { data: structuredClone(result), ts: Date.now() });
                pruneClaudeUsageCache(Date.now());
                return result;
            } catch { return { error: true }; }
        };
        const owned = probe().finally(() => {
            if (claudeUsageInflight.get(key) === owned) claudeUsageInflight.delete(key);
        });
        claudeUsageInflight.set(key, owned);
        pending = owned;
    }
    const result = await pending;
    if ('error' in result && result.reason === 'rate_limited') {
        const fallback = claudeUsageCache.get(key);
        if (fallback && Date.now() - fallback.ts < CLAUDE_FALLBACK_TTL_MS) {
            return { ...structuredClone(fallback.data), account: creds.account, cached: true };
        }
        return { ...result, account: creds.account };
    }
    if ('raw' in result) return { ...structuredClone(result), account: creds.account };
    return result;
}
export async function fetchCodexUsage(tokens: CodexTokensLike | null | undefined) {
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) return null;
    try {
        const signal = AbortSignal.timeout(8000);
        const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            redirect: 'error',
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id ?? '' },
            signal,
        });
        if (!resp.ok) {
            try { void resp.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
            if (resp.status === 401 || resp.status === 403) return { authenticated: false };
            return { error: true };
        }
        const raw = await readQuotaJson(resp);
        const parsed = parseCodexUsageWindows(raw);
        if (!parsed) return { error: true };
        const data = raw as Record<string, unknown>;
        const account = {
            email: typeof data['email'] === 'string' ? data['email'] : null,
            plan: typeof data['plan_type'] === 'string' ? data['plan_type'] : null,
        };
        return { account, ...parsed, raw };
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
    limitUsd?: number;
    usedUsd?: number;
    periodLabel: string;
    periodStart?: string | null;
    periodEnd?: string;
    email: string | null;
    source: string;
}

const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const GROK_JSON_CREDITS_URL = `${GROK_BILLING_URL}?format=credits`;
// OpenCodex b94051fe91e745806102988f6dff2fec8de078ef xai-transport compatibility.
const GROK_QUOTA_CLIENT_VERSION = '0.2.93';
const GROK_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user';
const GROK_WEB_CREDITS_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

function grokTierFromLimit(val: number): string {
    if (val >= 150_000) return 'SuperGrok Heavy';
    if (val >= 15_000) return 'SuperGrok';
    return `SuperGrok (${val} val)`;
}

interface GrokTokenCandidate {
    token: string;
    source: string;
    email?: string | null;
    userId?: string;
}

function grokUserIdFromAccessToken(token: string): string | undefined {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    try {
        const sub = asQuotaRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))?.['sub'];
        return typeof sub === 'string' && sub.trim() ? sub.trim() : undefined;
    } catch { return undefined; }
}

function readGrokTokenCandidates(homeDir = os.homedir()): GrokTokenCandidate[] {
    const candidates: GrokTokenCandidate[] = [];
    try {
        const authPath = join(homeDir, '.grok', 'auth.json');
        const data = asQuotaRecord(JSON.parse(fs.readFileSync(authPath, 'utf8')));
        const entries = Object.entries(data ?? {})
            .sort(([a], [b]) => Number(!a.startsWith('https://auth.x.ai::')) - Number(!b.startsWith('https://auth.x.ai::')));
        for (const [scope, value] of entries) {
            const entry = asQuotaRecord(value);
            if (!entry || typeof entry['key'] !== 'string' || !entry['key'].trim()) continue;
            const token = entry['key'].trim();
            const userId = typeof entry['user_id'] === 'string' && entry['user_id'].trim()
                ? entry['user_id'].trim() : grokUserIdFromAccessToken(token);
            candidates.push({
                token,
                source: scope.startsWith('https://auth.x.ai::') ? 'grok:auth-json-oidc' : 'grok:auth-json',
                email: typeof entry['email'] === 'string' ? entry['email'] : null,
                ...(userId ? { userId } : {}),
            });
        }
    } catch { /* native auth is optional */ }
    try {
        const data = asQuotaRecord(JSON.parse(fs.readFileSync(join(homeDir, '.progrok', 'auth.json'), 'utf8')));
        if (typeof data?.['accessToken'] === 'string' && data['accessToken'].trim()) {
            const token = data['accessToken'].trim();
            const userId = grokUserIdFromAccessToken(token);
            candidates.push({ token, source: 'progrok:auth-json', email: null, ...(userId ? { userId } : {}) });
        }
    } catch { /* legacy auth is optional */ }
    const seen = new Set<string>();
    return candidates.filter(candidate => {
        if (seen.has(candidate.token)) return false;
        seen.add(candidate.token);
        return true;
    });
}

interface ProtoField {
    path: number[];
    wireType: number;
    value: number;
    order: number;
}

function readGrpcWebPayloads(buf: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + 5 <= buf.length) {
        const flags = buf[offset] ?? 0;
        const len = buf.readUInt32BE(offset + 1);
        const start = offset + 5;
        const end = start + len;
        if (end > buf.length) return [];
        if ((flags & 0x80) === 0) frames.push(buf.subarray(start, end));
        offset = end;
    }
    if (frames.length) return frames;
    const first = buf[0] ?? 0;
    const wireType = first & 0x07;
    return first >> 3 > 0 && [0, 1, 2, 5].includes(wireType) ? [buf] : [];
}

function scanProtoFields(buf: Buffer, path: number[] = [], depth = 0, order = { value: 0 }): ProtoField[] {
    if (depth > 8) return [];
    const fields: ProtoField[] = [];
    let offset = 0;
    const readVarint = (): number | null => {
        let result = 0;
        let shift = 0;
        while (offset < buf.length && shift < 53) {
            const byte = buf[offset++] ?? 0;
            result += (byte & 0x7f) * (2 ** shift);
            if ((byte & 0x80) === 0) return result;
            shift += 7;
        }
        return null;
    };
    while (offset < buf.length) {
        const tag = readVarint();
        if (tag == null || tag === 0) break;
        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;
        const fieldPath = [...path, fieldNumber];
        if (wireType === 0) {
            const value = readVarint();
            if (value == null) break;
            fields.push({ path: fieldPath, wireType, value, order: order.value++ });
        } else if (wireType === 1) {
            if (offset + 8 > buf.length) break;
            offset += 8;
        } else if (wireType === 2) {
            const len = readVarint();
            if (len == null || offset + len > buf.length) break;
            const child = buf.subarray(offset, offset + len);
            offset += len;
            fields.push(...scanProtoFields(child, fieldPath, depth + 1, order));
        } else if (wireType === 5) {
            if (offset + 4 > buf.length) break;
            fields.push({ path: fieldPath, wireType, value: buf.readFloatLE(offset), order: order.value++ });
            offset += 4;
        } else {
            break;
        }
    }
    return fields;
}

export function parseGrokCreditsGrpcWeb(buf: Buffer, now = new Date()): Pick<GrokBillingData, 'percent' | 'periodEnd' | 'periodLabel' | 'source'> | null {
    const fields = readGrpcWebPayloads(buf).flatMap((payload) => scanProtoFields(payload));
    const percentField = fields
        .filter((field) => field.wireType === 5 && field.path.at(-1) === 1 && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
        .sort((a, b) => (a.path.length - b.path.length) || (a.order - b.order))[0];
    const futureResets = fields
        .filter((field) => field.wireType === 0 && field.value >= 1_700_000_000 && field.value <= 2_100_000_000)
        .map((field) => ({ field, date: new Date(field.value * 1000) }))
        .filter((entry) => entry.date > now)
        .sort((a, b) => {
            const aPreferred = a.field.path.join('.') === '1.5.1' ? 0 : 1;
            const bPreferred = b.field.path.join('.') === '1.5.1' ? 0 : 1;
            return (aPreferred - bPreferred) || (a.date.getTime() - b.date.getTime());
        });
    const reset = futureResets[0]?.date;
    const hasUsagePeriod = fields.some((field) =>
        field.wireType === 0 && (field.path.slice(0, 2).join('.') === '1.6' || (field.path.join('.') === '1.8.1' && (field.value === 1 || field.value === 2)))
    );
    const percent = percentField?.value ?? (reset && hasUsagePeriod ? 0 : null);
    if (percent == null || !reset) return null;
    return {
        percent: Math.round(percent),
        periodEnd: reset.toISOString(),
        periodLabel: 'weekly',
        source: 'grok:grok-build-billing-grpc-web',
    };
}

export function parseGrokCreditsResponse(value: unknown): {
    percent: number; periodEnd?: string;
} | null {
    const config = asQuotaRecord(asQuotaRecord(value)?.['config']);
    const period = asQuotaRecord(config?.['currentPeriod']);
    if (!config || period?.['type'] !== 'USAGE_PERIOD_TYPE_WEEKLY') return null;
    const percent = config['creditUsagePercent'] === undefined
        ? 0 : quotaPercent(config['creditUsagePercent']);
    if (percent === undefined) return null;
    const periodEnd = quotaResetIso(period['end']);
    return { percent, ...(periodEnd ? { periodEnd } : {}) };
}

type GrokWeeklyCredits = Pick<GrokBillingData, 'percent' | 'periodEnd' | 'periodLabel' | 'source'>;

async function fetchGrokWeeklyCreditsJson(candidate: GrokTokenCandidate): Promise<GrokWeeklyCredits | null> {
    if (!candidate.userId) return null;
    try {
        const response = await fetch(GROK_JSON_CREDITS_URL, {
            redirect: 'error',
            headers: {
                Accept: 'application/json', Authorization: `Bearer ${candidate.token}`,
                'x-userid': candidate.userId,
                'x-xai-token-auth': 'xai-grok-cli',
                'x-authenticateresponse': 'authenticate-response',
                'x-grok-client-version': GROK_QUOTA_CLIENT_VERSION,
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return null;
        const parsed = parseGrokCreditsResponse(await readQuotaJson(response));
        return parsed ? { ...parsed, periodLabel: 'weekly', source: 'grok:cli-chat-proxy-billing-credits' } : null;
    } catch { return null; }
}

async function fetchGrokWeeklyCredits(token: string): Promise<Pick<GrokBillingData, 'percent' | 'periodEnd' | 'periodLabel' | 'source'> | null> {
    try {
        const resp = await fetch(GROK_WEB_CREDITS_URL, {
            method: 'POST',
            redirect: 'error',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-XAI-Token-Auth': 'xai-grok-cli',
                'Origin': 'https://grok.com',
                'Referer': 'https://grok.com/?_s=usage',
                'Accept': 'application/grpc-web+proto',
                'Content-Type': 'application/grpc-web+proto',
                'x-grpc-web': '1',
                'x-user-agent': 'connect-es/2.1.1',
            },
            body: Buffer.from([0, 0, 0, 0, 0]),
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        return parseGrokCreditsGrpcWeb(Buffer.from(await readQuotaBytes(resp)));
    } catch { return null; }
}

async function fetchGrokMonthlyBilling(candidate: GrokTokenCandidate): Promise<GrokBillingData | null> {
    try {
        const headers = { Accept: 'application/json', Authorization: `Bearer ${candidate.token}` };
        const [billingRes, userRes] = await Promise.allSettled([
            fetch(GROK_BILLING_URL, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) }),
            fetch(GROK_USER_URL, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) }),
        ]);
        if (billingRes.status !== 'fulfilled' || !billingRes.value.ok) return null;
        const billing = asQuotaRecord(asQuotaRecord(await readQuotaJson(billingRes.value))?.['config']);
        if (!billing) return null;
        const limit = quotaNumber(asQuotaRecord(billing['monthlyLimit'])?.['val']);
        const used = quotaNumber(asQuotaRecord(billing['used'])?.['val']);
        if (limit === undefined || used === undefined || limit <= 0) return null;
        const percent = quotaPercent(used / limit * 100);
        if (percent === undefined) return null;
        let email = candidate.email ?? null;
        if (userRes.status === 'fulfilled' && userRes.value.ok) {
            try {
                const user = asQuotaRecord(await readQuotaJson(userRes.value, 5000));
                if (typeof user?.['email'] === 'string') email = user['email'];
            } catch { /* optional identity metadata must not discard valid billing */ }
        }
        const periodEnd = quotaResetIso(billing['billingPeriodEnd']);
        return {
            tier: grokTierFromLimit(limit), limit, used, percent,
            limitUsd: limit / 100, usedUsd: used / 100,
            periodLabel: 'monthly', periodStart: quotaResetIso(billing['billingPeriodStart']),
            ...(periodEnd ? { periodEnd } : {}), email,
            source: candidate.source === 'progrok:auth-json' ? 'progrok:billing-api' : 'grok:cli-chat-proxy-billing-api',
        };
    } catch { return null; }
}

export async function fetchGrokBilling(homeDir = os.homedir()): Promise<GrokBillingData | null> {
    const tokens = readGrokTokenCandidates(homeDir);
    const weeklyReaders = [fetchGrokWeeklyCreditsJson, (candidate: GrokTokenCandidate) => fetchGrokWeeklyCredits(candidate.token)];
    for (const read of weeklyReaders) {
        for (const candidate of tokens) {
            const weekly = await read(candidate);
            if (weekly) return {
                tier: 'SuperGrok', limit: 100, used: weekly.percent,
                ...weekly, email: candidate.email ?? null,
            };
        }
    }
    for (const candidate of tokens) {
        const monthly = await fetchGrokMonthlyBilling(candidate);
        if (monthly) return monthly;
    }
    return null;
}

export async function fetchGrokStatus(binary = 'grok') {
    let authenticated = false;
    let source = 'none';
    if (probeGrokModels(binary) !== null) {
        authenticated = true;
        source = 'grok models';
    }
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
