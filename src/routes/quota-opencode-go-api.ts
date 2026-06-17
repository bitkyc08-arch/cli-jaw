// OpenCode Go subscription quota via Bearer API key (zen/go/v1/usage).

import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { JAW_HOME, SETTINGS_PATH } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const OPENCODE_AUTH_FILE = join(os.homedir(), '.local/share/opencode/auth.json');
const OPENCODE_GO_API_KEY_FILE = join(JAW_HOME, 'quota', 'opencode-go-api-key');

type QuotaRecord = Record<string, unknown>;

interface UsageWindowInput {
    usagePercent?: number;
    usage_percent?: number;
    percent?: number;
    resetInSec?: number;
    resetInSeconds?: number;
    resets_in_seconds?: number;
    limitDollars?: number;
    limit_dollars?: number;
    usedDollars?: number;
    used_dollars?: number;
}

function asRecord(value: unknown): QuotaRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as QuotaRecord
        : null;
}

function numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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

function windowFromInput(input: UsageWindowInput | null | undefined): { label: string; percent: number; resetsAt?: string | null } | null {
    if (!input) return null;
    const percent = numberField(input.usagePercent)
        ?? numberField(input.usage_percent)
        ?? numberField(input.percent);
    if (percent == null) return null;
    const resetSec = numberField(input.resetInSec)
        ?? numberField(input.resetInSeconds)
        ?? numberField(input.resets_in_seconds);
    const resetsAt = resetSec != null
        ? new Date(Date.now() + resetSec * 1000).toISOString()
        : null;
    return {
        percent: Math.round(Math.max(0, Math.min(100, percent))),
        resetsAt,
        label: '',
    };
}

export function normalizeOpenCodeGoUsage(data: unknown): QuotaRecord {
    const root = asRecord(data);
    if (!root) {
        return { error: true, reason: 'usage_parse_failed' };
    }

    const windows: Array<{ label: string; percent: number; resetsAt?: string | null }> = [];
    const push = (label: string, input: UsageWindowInput | null | undefined) => {
        const window = windowFromInput(input);
        if (!window) return;
        windows.push({ ...window, label });
    };

    const nested = asRecord(root['windows']);
    push('5h', asRecord(root['rolling5h']) as UsageWindowInput | null
        ?? asRecord(root['rolling']) as UsageWindowInput | null
        ?? nested?.['rolling'] as UsageWindowInput | undefined);
    push('Weekly', asRecord(root['weekly']) as UsageWindowInput | null
        ?? nested?.['weekly'] as UsageWindowInput | undefined);
    push('Monthly', asRecord(root['monthly']) as UsageWindowInput | null
        ?? nested?.['monthly'] as UsageWindowInput | undefined);

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

export async function probeOpenCodeGoApiKey(apiKey: string): Promise<boolean> {
    try {
        const resp = await fetch(OPENCODE_GO_MODELS_URL, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return false;
        const data = await resp.json() as unknown;
        return asRecord(data)?.['object'] === 'list';
    } catch {
        return false;
    }
}

export async function fetchOpenCodeGoUsageApi(apiKey: string): Promise<QuotaRecord | null> {
    try {
        const resp = await fetch(OPENCODE_GO_USAGE_URL, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (resp.status === 401 || resp.status === 403) {
            return { authenticated: false, reason: 'api_key_invalid' };
        }
        if (resp.status === 404) {
            return { usageApiUnavailable: true, reason: 'usage_api_not_deployed' };
        }
        if (!resp.ok) {
            return { error: true, reason: 'usage_fetch_failed' };
        }
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
            return { usageApiUnavailable: true, reason: 'usage_api_not_json' };
        }
        const data = await resp.json() as unknown;
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

function mergeOpenCodeQuota(base: QuotaRecord, overlay: QuotaRecord | null): QuotaRecord {
    if (!overlay) return base;
    if (overlay['authenticated'] === false) {
        return stripUndefined({
            ...base,
            authenticated: false,
            quotaCapable: false,
            reason: overlay['reason'] ?? 'api_key_invalid',
            dashboardHint: 'OpenCode Go API key was rejected. Re-run opencode providers login or update OPENCODE_GO_API_KEY.',
        });
    }
    if (overlay['usageApiUnavailable']) {
        return stripUndefined({
            ...base,
            authenticated: base['authenticated'] !== false,
            quotaCapable: false,
            quotaSource: 'opencode-go:usage-api-unavailable',
            usageApiUnavailable: true,
            dashboardHint: 'GET /zen/go/v1/usage is not live yet (upstream anomalyco/opencode#16017). API key works for models; quota bar will appear when the endpoint ships.',
            windows: [],
        });
    }
    if (overlay['error']) {
        return stripUndefined({
            ...base,
            error: true,
            reason: overlay['reason'] ?? 'usage_fetch_failed',
        });
    }
    return stripUndefined({
        ...base,
        ...overlay,
        authenticated: true,
        account: { ...(asRecord(base['account']) || {}), ...(asRecord(overlay['account']) || {}) },
    });
}

export async function fetchOpenCodeUsage(): Promise<QuotaRecord> {
    const apiKey = readOpenCodeGoApiKey();
    if (!apiKey) return buildStatusOnly();

    const authenticated = await probeOpenCodeGoApiKey(apiKey);
    const base = stripUndefined({
        ...buildStatusOnly(),
        authenticated,
        displayTier: 'OpenCode Go',
        account: { type: 'opencode', tier: authenticated ? 'Go' : 'auth/status only' },
        quotaSource: authenticated ? 'opencode-go:api-key-probed' : 'opencode-go:api-key-invalid',
    });

    if (!authenticated) {
        return stripUndefined({
            ...base,
            dashboardHint: 'Set OPENCODE_GO_API_KEY or run opencode providers login for OpenCode Go.',
        });
    }

    const usage = await fetchOpenCodeGoUsageApi(apiKey);
    return mergeOpenCodeQuota(base, usage);
}
