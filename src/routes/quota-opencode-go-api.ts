// OpenCode Go quota, adapted from OpenCodex src/providers/quota.ts at
// b94051fe91e745806102988f6dff2fec8de078ef (MIT; see LICENSE).

import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { JAW_HOME, SETTINGS_PATH } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { asQuotaRecord as asRecord, quotaNumber, quotaPercent, quotaResetIso, readQuotaJson } from './quota-wire.js';

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const OPENCODE_AUTH_FILE = join(os.homedir(), '.local/share/opencode/auth.json');
const OPENCODE_GO_API_KEY_FILE = join(JAW_HOME, 'quota', 'opencode-go-api-key');

type QuotaRecord = Record<string, unknown>;

function readTrimmedEnv(name: string): string | null {
    const value = process.env[name]?.trim();
    return value || null;
}

function readApiKeyFromFile(filePath: string): string | null {
    try {
        const value = fs.readFileSync(filePath, 'utf8').trim();
        return value || null;
    } catch {
        return null;
    }
}

function readApiKeyFromSettings(): string | null {
    try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
        const quota = settings['quota'];
        if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null;
        const key = (quota as Record<string, unknown>)['opencodeGoApiKey'];
        return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch {
        return null;
    }
}

export function readOpenCodeGoApiKey(): string | null {
    return readTrimmedEnv('OPENCODE_GO_API_KEY')
        ?? readApiKeyFromFile(OPENCODE_GO_API_KEY_FILE)
        ?? readApiKeyFromAuthFile()
        ?? readApiKeyFromSettings();
}

function readApiKeyFromAuthFile(): string | null {
    try {
        const auth = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8')) as Record<string, unknown>;
        const entry = auth['opencode-go'];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const key = (entry as Record<string, unknown>)['key'];
        return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch {
        return null;
    }
}

function windowFromInput(value: unknown, now: number, canonical: boolean) {
    const input = asRecord(value);
    if (!input) return null;
    const percent = quotaPercent(canonical ? input['percent']
        : quotaNumber(input['usagePercent']) ?? quotaNumber(input['usage_percent']) ?? input['percent']);
    if (percent === undefined) return null;
    let resetsAt = quotaResetIso(input['resetsAt']);
    if (!resetsAt && !canonical) {
        const seconds = quotaNumber(input['resetInSec']) ?? quotaNumber(input['resetInSeconds'])
            ?? quotaNumber(input['resets_in_seconds']);
        if (seconds !== undefined && seconds >= 0) resetsAt = quotaResetIso(now + seconds * 1000);
    }
    // Preserve legacy display rounding; canonical usage carries exact fractions.
    return { percent: canonical ? percent : Math.round(percent), resetsAt };
}

export function normalizeOpenCodeGoUsage(data: unknown): QuotaRecord {
    const root = asRecord(data);
    if (!root) {
        return { error: true, reason: 'usage_parse_failed' };
    }

    const canonical = Object.hasOwn(root, 'usage');
    const usage = asRecord(root['usage']);
    if (canonical && !usage) return { error: true, reason: 'usage_parse_failed' };
    const windows: Array<{ label: string; percent: number; resetsAt: string | null }> = [];
    const now = Date.now();
    const nested = asRecord(root['windows']);
    const inputs = canonical ? [usage?.['rolling'], usage?.['weekly'], usage?.['monthly']]
        : [asRecord(root['rolling5h']) ?? asRecord(root['rolling']) ?? asRecord(nested?.['rolling']),
            asRecord(root['weekly']) ?? asRecord(nested?.['weekly']),
            asRecord(root['monthly']) ?? asRecord(nested?.['monthly'])];
    for (const [i, label] of ['5h', 'Weekly', 'Monthly'].entries()) {
        const window = windowFromInput(inputs[i], now, canonical);
        if (window) windows.push({ ...window, label });
    }

    return stripUndefined({
        authenticated: true,
        quotaCapable: windows.length > 0,
        quotaSource: 'opencode-go:usage-api',
        futureQuotaHook: 'zen-go-v1-usage',
        displayTier: 'OpenCode Go',
        account: {
            type: 'opencode',
            tier: typeof root['plan'] === 'string' ? root['plan'] : 'Go',
            plan: 'Go',
        },
        windows,
        subscribedAt: typeof root['subscribedAt'] === 'string' ? root['subscribedAt'] : undefined,
    });
}

type KeyProbe = 'authenticated' | 'rejected' | 'unavailable';

async function probeOpenCodeGoKeyStatus(apiKey: string): Promise<KeyProbe> {
    try {
        const resp = await fetch(OPENCODE_GO_MODELS_URL, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
            void resp.body?.cancel().catch(() => undefined);
            return resp.status === 401 || resp.status === 403 ? 'rejected' : 'unavailable';
        }
        return asRecord(await readQuotaJson(resp))?.['object'] === 'list' ? 'authenticated' : 'unavailable';
    } catch { return 'unavailable'; }
}

export async function probeOpenCodeGoApiKey(apiKey: string): Promise<boolean> {
    return await probeOpenCodeGoKeyStatus(apiKey) === 'authenticated';
}

export async function fetchOpenCodeGoUsageApi(apiKey: string): Promise<QuotaRecord | null> {
    try {
        const resp = await fetch(OPENCODE_GO_USAGE_URL, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) void resp.body?.cancel().catch(() => undefined);
        if (resp.status === 401 || resp.status === 403) {
            return { authenticated: false, reason: 'api_key_invalid' };
        }
        if (resp.status === 404) {
            return { usageApiUnavailable: true, reason: 'usage_api_unavailable' };
        }
        if (!resp.ok) {
            return { error: true, reason: 'usage_fetch_failed' };
        }
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
            void resp.body?.cancel().catch(() => undefined);
            return { usageApiUnavailable: true, reason: 'usage_api_not_json' };
        }
        const data = await readQuotaJson(resp);
        return normalizeOpenCodeGoUsage(data);
    } catch {
        return { error: true, reason: 'usage_fetch_failed' };
    }
}

function buildStatusOnly(): QuotaRecord {
    return stripUndefined({
        authenticated: false,
        quotaCapable: false,
        quotaSource: 'not-exposed-by-opencode-cli',
        futureQuotaHook: 'zen-go-v1-usage',
        displayTier: 'OpenCode Go',
        account: { type: 'opencode', tier: 'auth/status only' },
        windows: [],
    });
}

export async function fetchOpenCodeUsage(): Promise<QuotaRecord> {
    const apiKey = readOpenCodeGoApiKey();
    if (!apiKey) return buildStatusOnly();
    // Presence proves only a configured key; failures must not invent an auth verdict.
    const base: QuotaRecord = {
        quotaCapable: false, windows: [], displayTier: 'OpenCode Go',
        account: { type: 'opencode', tier: 'Go' }, quotaSource: 'opencode-go:usage-api',
    };
    const usage = await fetchOpenCodeGoUsageApi(apiKey);
    if (!usage) return { ...base, error: true, reason: 'usage_fetch_failed' };
    if (!usage['usageApiUnavailable']) return { ...base, ...usage };
    const probe = await probeOpenCodeGoKeyStatus(apiKey);
    return {
        ...base, ...usage, quotaSource: 'opencode-go:usage-api-unavailable',
        ...(probe === 'authenticated' ? { authenticated: true }
            : probe === 'rejected' ? { authenticated: false, reason: 'api_key_invalid' } : { error: true }),
        dashboardHint: 'OpenCode Go quota endpoint is unavailable for this response; model access and quota availability are checked separately.',
    };
}
