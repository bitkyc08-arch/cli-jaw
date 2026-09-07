// Reverse-engineered Cursor dashboard quota reader (unofficial API).

import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'path';
import { JAW_HOME, SETTINGS_PATH } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { asQuotaRecord, quotaNumber, quotaPercent, quotaResetIso, readQuotaJson } from './quota-wire.js';

const execFileAsync = promisify(execFile);

const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const CURSOR_SESSION_TOKEN_FILE = join(JAW_HOME, 'quota', 'cursor-session-token');

type QuotaRecord = Record<string, unknown>;

async function readCursorJsonCommand(binary: string, command: string, args: string[] = []): Promise<QuotaRecord | null> {
    try {
        const { stdout } = await execFileAsync(binary, [command, ...args], {
            encoding: 'utf8',
            timeout: 5000,
        });
        const parsed = JSON.parse(stdout) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as QuotaRecord
            : null;
    } catch {
        return null;
    }
}

// Native store contract: Cursor CLI 2026.09.02-c22c1a3 credential manager.
// Read only; never invoke its login/refresh or write-back paths.
export function getCursorNativeAuthPath(
    platform: NodeJS.Platform = process.platform,
    homeDir = os.homedir(),
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (platform === 'win32') return path.win32.join(
        env['APPDATA'] || path.win32.join(homeDir, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
    if (platform === 'darwin') return path.posix.join(homeDir, '.cursor', 'auth.json');
    return path.posix.join(env['XDG_CONFIG_HOME'] || path.posix.join(homeDir, '.config'), 'cursor', 'auth.json');
}
export async function readCursorNativeAccessToken(options: {
    platform?: NodeJS.Platform; homeDir?: string; env?: NodeJS.ProcessEnv;
} = {}): Promise<string | null> {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const token = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
    const direct = token(env['CURSOR_AUTH_TOKEN']);
    if (direct) return direct;
    if (token(env['CURSOR_API_KEY'])) return null;
    if (env['AGENT_CLI_CREDENTIAL_STORE'] === 'memory') return null;
    if (env['AGENT_CLI_CREDENTIAL_STORE'] === 'file' || platform !== 'darwin') {
        try {
            const file = getCursorNativeAuthPath(platform, options.homeDir ?? os.homedir(), env);
            return token(asQuotaRecord(JSON.parse(fs.readFileSync(file, 'utf8')))?.['accessToken']);
        } catch { return null; }
    }
    try {
        const { stderr } = await execFileAsync('/usr/bin/security',
            ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-g'],
            { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
        const hex = stderr.match(/^password: 0x([0-9a-fA-F]+)\s*$/m);
        if (hex) return hex[1]!.length % 2 === 0 ? token(Buffer.from(hex[1]!, 'hex').toString('utf8')) : null;
        return token(stderr.match(/^password: "(.*)"\s*$/m)?.[1]);
    } catch { return null; }
}

export function readCursorDashboardSessionToken(): string | null {
    for (const key of ['CURSOR_SESSION_TOKEN', 'CURSOR_DASHBOARD_SESSION_TOKEN']) {
        const value = process.env[key]?.trim();
        if (value) return value;
    }
    try {
        const fromFile = fs.readFileSync(CURSOR_SESSION_TOKEN_FILE, 'utf8').trim();
        if (fromFile) return fromFile;
    } catch { /* optional local token file */ }
    try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
        const quota = settings['quota'];
        if (quota && typeof quota === 'object' && !Array.isArray(quota)) {
            const token = (quota as Record<string, unknown>)['cursorSessionToken'];
            if (typeof token === 'string' && token.trim()) return token.trim();
        }
    } catch { /* settings may be absent during tests */ }
    return null;
}

export async function readCursorStatus(binary = 'cursor-agent'): Promise<QuotaRecord> {
    let authenticated = false;
    let source = 'none';
    let subscriptionTier: string | undefined;
    let cliVersion: string | undefined;
    let userEmail: string | undefined;
    let defaultModel: string | undefined;

    if (process.env["CURSOR_API_KEY"]?.trim()) {
        authenticated = true;
        source = 'CURSOR_API_KEY';
    }

    const [status, about] = await Promise.all([
        readCursorJsonCommand(binary, 'status', ['--format', 'json']),
        readCursorJsonCommand(binary, 'about', ['--format', 'json']),
    ]);
    if (status) {
        authenticated = status["isAuthenticated"] === true
            || status["status"] === 'authenticated'
            || authenticated;
        const userInfo = status["userInfo"];
        if (userInfo && typeof userInfo === 'object' && !Array.isArray(userInfo)) {
            const email = (userInfo as QuotaRecord)["email"];
            if (typeof email === 'string' && email.trim()) userEmail = email;
        }
        if (authenticated && source === 'none') source = 'cursor-agent status';
    }

    if (about) {
        if (typeof about["subscriptionTier"] === 'string') subscriptionTier = about["subscriptionTier"];
        if (typeof about["cliVersion"] === 'string') cliVersion = about["cliVersion"];
        if (typeof about["model"] === 'string') defaultModel = about["model"];
        if (typeof about["userEmail"] === 'string' && about["userEmail"].trim()) {
            userEmail = about["userEmail"];
        }
        if (authenticated && source === 'none') source = 'cursor-agent about';
    }

    return stripUndefined({
        authenticated,
        quotaCapable: false,
        quotaSource: 'not-exposed-by-cursor-cli',
        futureQuotaHook: 'cursor-dashboard-unofficial-api',
        displayTier: subscriptionTier ? `Cursor ${subscriptionTier}` : 'Cursor',
        account: stripUndefined({
            type: 'cursor',
            tier: subscriptionTier ?? 'auth/status only',
            email: userEmail,
        }),
        source,
        cliVersion,
        defaultModel,
        subscriptionTier,
        windows: [],
    });
}

export function normalizeCursorUsageSummary(data: QuotaRecord): QuotaRecord {
    const individualUsage = asQuotaRecord(data["individualUsage"]);
    const plan = asQuotaRecord(individualUsage?.["plan"]);
    const windows: Array<{ label: string; percent: number; resetsAt?: string | null }> = [];
    const resetsAt = quotaResetIso(data["billingCycleEnd"]);
    const membershipType = typeof data["membershipType"] === 'string' ? data["membershipType"] : undefined;

    const used = quotaNumber(plan?.["used"]);
    const limit = quotaNumber(plan?.["limit"]);
    const totalPercentUsed = quotaPercent(plan?.["totalPercentUsed"])
        ?? (used !== undefined && limit !== undefined && limit > 0 ? quotaPercent(used / limit * 100) : undefined);
    const apiPercentUsed = quotaPercent(plan?.["apiPercentUsed"]);
    const autoPercentUsed = quotaPercent(plan?.["autoPercentUsed"]);

    if (totalPercentUsed != null) {
        windows.push({ label: 'Cycle', percent: totalPercentUsed, resetsAt });
    } else if (apiPercentUsed != null) {
        windows.push({ label: 'API', percent: apiPercentUsed, resetsAt });
    }
    if (autoPercentUsed != null && autoPercentUsed > 0) {
        windows.push({ label: 'Auto', percent: autoPercentUsed, resetsAt });
    }

    return stripUndefined({
        authenticated: true,
        quotaCapable: windows.length > 0,
        quotaSource: 'cursor-dashboard-unofficial-api',
        displayTier: membershipType ? `Cursor ${membershipType}` : 'Cursor',
        account: stripUndefined({
            type: 'cursor',
            tier: membershipType,
            plan: membershipType,
        }),
        windows,
        billingCycleStart: quotaResetIso(data["billingCycleStart"]),
        billingCycleEnd: resetsAt,
        planUsed: quotaNumber(plan?.["used"]),
        planLimit: quotaNumber(plan?.["limit"]),
        planRemaining: quotaNumber(plan?.["remaining"]),
        reverseEngineered: true,
    });
}

export async function fetchCursorDashboardUsage(sessionToken: string): Promise<QuotaRecord | null> {
    try {
        const resp = await fetch(CURSOR_USAGE_SUMMARY_URL, {
            headers: { Accept: 'application/json', Cookie: `WorkosCursorSessionToken=${sessionToken}` },
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
        });
        if (resp.status === 401 || resp.status === 403) {
            return { authenticated: false, reason: 'dashboard_session_expired' };
        }
        if (!resp.ok) return { error: true };
        const data = asQuotaRecord(await readQuotaJson(resp));
        if (!data) return { error: true };
        return normalizeCursorUsageSummary(data);
    } catch {
        return { error: true };
    }
}

// Quota semantics adapted from OpenCodex b94051fe91e745806102988f6dff2fec8de078ef.
type CursorWindow = { label: string; percent: number; resetsAt: string | null };
function cursorNativeQuota(source: string, windows: CursorWindow[]): QuotaRecord | null {
    return windows.length ? { authenticated: true, quotaCapable: true, quotaSource: source,
        windows, reverseEngineered: true } : null;
}
export function normalizeCursorPeriodUsage(value: unknown): QuotaRecord | null {
    const body = asQuotaRecord(value);
    const plan = asQuotaRecord(body?.['planUsage']);
    if (!body || !plan) return null;
    const resetsAt = quotaResetIso(body['billingCycleEnd'] ?? plan['billingCycleEnd'] ?? body['periodEnd']);
    const limit = quotaNumber(plan['limit'] ?? plan['limitCents'] ?? plan['totalLimitCents']);
    const remaining = quotaNumber(plan['remaining'] ?? plan['remainingCents']);
    const included = quotaNumber(plan['includedSpend'] ?? plan['usedCents'] ?? plan['used']);
    const totalSpend = quotaNumber(plan['totalSpend']);
    const used = included !== undefined ? included
        : limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : totalSpend;
    const total = quotaPercent(plan['totalPercentUsed'] ?? plan['percentUsed'])
        ?? (limit !== undefined && limit > 0 && used !== undefined ? quotaPercent(used / limit * 100) : undefined);
    const auto = quotaPercent(plan['autoPercentUsed']);
    const api = quotaPercent(plan['apiPercentUsed']);
    const windows: CursorWindow[] = [];
    if (total !== undefined) windows.push({ label: 'Cycle', percent: total, resetsAt });
    if (auto !== undefined) windows.push({ label: 'First-party models', percent: auto, resetsAt });
    if (api !== undefined) windows.push({ label: 'API usage', percent: api, resetsAt });
    return cursorNativeQuota('cursor:period-usage', windows);
}
export function normalizeCursorNativeSummary(value: unknown): QuotaRecord | null {
    const body = asQuotaRecord(value);
    const plan = asQuotaRecord(asQuotaRecord(body?.['individualUsage'])?.['plan']);
    if (!body || !plan) return null;
    const used = quotaNumber(plan['used']);
    const limit = quotaNumber(plan['limit']);
    const percent = quotaPercent(plan['totalPercentUsed'])
        ?? (used !== undefined && limit !== undefined && limit > 0 ? quotaPercent(used / limit * 100) : undefined);
    return percent === undefined ? null : cursorNativeQuota('cursor:usage-summary', [
        { label: 'Cycle', percent, resetsAt: quotaResetIso(body['billingCycleEnd']) },
    ]);
}
export function normalizeCursorAuthUsage(value: unknown): QuotaRecord | null {
    const body = asQuotaRecord(value);
    if (!body) return null;
    const bucket = (value: unknown) => {
        const record = asQuotaRecord(value);
        if (!record) return null;
        const used = quotaNumber(record['numRequests'] ?? record['used']);
        const limit = quotaNumber(record['maxRequestUsage'] ?? record['limit'] ?? record['maxRequests']);
        if (used === undefined || limit === undefined || limit <= 0) return null;
        const percent = quotaPercent(used / limit * 100);
        return percent === undefined ? null : { percent };
    };
    let selected = bucket(body['gpt-4']);
    if (!selected) for (const [key, value] of Object.entries(body)) {
        if (key === 'startOfMonth' || key === 'billingCycleStart') continue;
        selected = bucket(value);
        if (selected) break;
    }
    if (!selected) return null;
    const startIso = quotaResetIso(body['startOfMonth'] ?? body['billingCycleStart']);
    let resetsAt: string | null = null;
    if (startIso) {
        const start = new Date(startIso);
        // Date.UTC overflow behavior matches reference; do not clamp to month end.
        resetsAt = quotaResetIso(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()));
    }
    return cursorNativeQuota('cursor:auth-usage', [{ label: 'Cycle', percent: selected.percent, resetsAt }]);
}
export async function fetchCursorNativeUsage(accessToken: string): Promise<QuotaRecord | null> {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'cli-jaw-quota' };
    const stages = [
        { url: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
            parse: normalizeCursorPeriodUsage, post: true },
        { url: 'https://api2.cursor.sh/api/usage/summary', parse: normalizeCursorNativeSummary, post: false },
        { url: 'https://api2.cursor.sh/auth/usage', parse: normalizeCursorAuthUsage, post: false },
    ];
    for (const stage of stages) {
        try {
            const response = await fetch(stage.url, {
                method: stage.post ? 'POST' : 'GET', redirect: 'error',
                headers: stage.post ? { ...headers, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' } : headers,
                ...(stage.post ? { body: '{}' } : {}), signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) continue;
            const quota = stage.parse(await readQuotaJson(response));
            if (quota) return quota;
        } catch { /* next fixed endpoint; never return raw errors or refresh credentials */ }
    }
    return null;
}

function mergeCursorQuota(base: QuotaRecord, overlay: QuotaRecord | null): QuotaRecord {
    if (!overlay) return base;
    if (overlay["authenticated"] === false) {
        return stripUndefined({
            ...base,
            dashboardAuth: false,
            dashboardHint: 'Set CURSOR_SESSION_TOKEN or ~/.cli-jaw/quota/cursor-session-token from cursor.com dashboard cookie WorkosCursorSessionToken',
        });
    }
    if (overlay["error"]) {
        return stripUndefined({ ...base, error: true, reason: 'dashboard_fetch_failed' });
    }
    return stripUndefined({
        ...base,
        ...overlay,
        authenticated: overlay["authenticated"] === true || base["authenticated"] === true,
        account: { ...(asQuotaRecord(base["account"]) || {}), ...(asQuotaRecord(overlay["account"]) || {}) },
    });
}

export async function fetchCursorUsage(binary = 'cursor-agent'): Promise<QuotaRecord> {
    const base = await readCursorStatus(binary);
    const accessToken = await readCursorNativeAccessToken();
    if (accessToken) {
        const native = await fetchCursorNativeUsage(accessToken);
        if (native) return mergeCursorQuota(base, native);
    }
    const sessionToken = readCursorDashboardSessionToken();
    if (sessionToken) return mergeCursorQuota(base, await fetchCursorDashboardUsage(sessionToken));
    return accessToken ? { ...base, error: true, reason: 'native_quota_unavailable' } : base;
}
