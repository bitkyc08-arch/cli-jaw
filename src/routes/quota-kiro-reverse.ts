// Reverse-engineered Kiro / CodeWhisperer quota reader.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    readKiroQuotaAuthFromStore,
    resolveKiroProfileArn,
} from '../agent/kiro-auth.js';
import { detectCli } from '../core/cli-detection.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { asQuotaRecord as asRecord, quotaNumber, quotaPercent, quotaResetIso, readQuotaJson } from './quota-wire.js';

const execFileAsync = promisify(execFile);

type QuotaRecord = Record<string, unknown>;

function textField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function allowance(row: QuotaRecord | null) {
    if (!row) return null;
    const used = quotaNumber(row['currentUsageWithPrecision']) ?? quotaNumber(row['currentUsage']);
    const limit = quotaNumber(row['usageLimitWithPrecision']) ?? quotaNumber(row['usageLimit']);
    if (used === undefined || used < 0 || limit === undefined || limit <= 0) return null;
    const percent = quotaPercent(used / limit * 100);
    return percent === undefined ? null : { used, limit, percent };
}

/** Allowance selection adapted from OpenCodex providers/kiro-usage.ts,
 * b94051fe91e745806102988f6dff2fec8de078ef (MIT; see LICENSE).
 */
export function normalizeKiroUsageLimits(value: unknown): QuotaRecord {
    const data = asRecord(value);
    if (!data) return { error: true, reason: 'kiro_usage_parse_failed', quotaCapable: false, windows: [] };
    const windows: Array<{ label: string; percent: number; resetsAt: string | null }> = [];
    const subscription = asRecord(data['subscriptionInfo']);
    const resetsAt = quotaResetIso(data['nextDateReset']);
    const list = Array.isArray(data['usageBreakdownList']) ? data['usageBreakdownList'].map(asRecord) : [];
    const selected = ['AGENTIC_REQUEST', 'CREDIT'].map(type => list.find(row =>
        textField(row?.['resourceType'])?.toUpperCase() === type)).find(Boolean) ?? null;
    const primary = allowance(selected);
    const overageStatus = textField(asRecord(data['overageConfiguration'])?.['overageStatus']);
    if (primary && selected) {
        windows.push({ label: textField(selected['displayName']) || textField(selected['resourceType']) || 'Usage',
            percent: primary.percent, resetsAt: quotaResetIso(selected['nextDateReset']) ?? resetsAt });
        const trialRow = asRecord(selected['freeTrialInfo']);
        const trial = allowance(trialRow);
        if (trial) windows.push({ label: 'Free trial', percent: trial.percent, resetsAt: quotaResetIso(trialRow?.['nextDateReset']) });
    } else if (!Object.hasOwn(data, 'usageBreakdownList') && Array.isArray(data['limits'])) {
        for (const value of data['limits']) {
            const row = asRecord(value);
            if (!row) continue;
            const current = quotaNumber(row['currentUsage']);
            const limit = quotaNumber(row['totalUsageLimit']);
            const percent = quotaPercent(row['percentUsed']) ??
                (current !== undefined && current >= 0 && limit !== undefined && limit > 0 ? quotaPercent(current / limit * 100) : undefined);
            if (percent !== undefined) windows.push({ label: textField(row['type']) || 'Usage', percent, resetsAt });
        }
    }
    const title = textField(subscription?.['subscriptionTitle']);
    const type = textField(subscription?.['type']);
    return stripUndefined({
        authenticated: true, quotaCapable: windows.length > 0,
        quotaSource: 'kiro:codewhisperer-get-usage-limits',
        displayTier: title || type ? `Kiro ${title || type}` : 'Kiro',
        account: stripUndefined({ type: 'kiro', tier: title || type || 'authenticated', plan: type }),
        windows, daysUntilReset: quotaNumber(data['daysUntilReset']), nextDateReset: resetsAt,
        currentUsage: primary?.used, usageLimit: primary?.limit,
        usageUnit: primary ? textField(selected?.['displayNamePlural']) || textField(selected?.['displayName']) : undefined,
        overageStatus, exhausted: primary ? primary.used >= primary.limit && overageStatus?.toUpperCase() !== 'ENABLED' : undefined,
        reverseEngineered: true,
    });
}

function kiroUsageRegion(profileArn?: string, regions?: { apiRegion?: string; ssoRegion?: string }): string {
    return [profileArn?.split(':')[3], regions?.apiRegion, regions?.ssoRegion]
        .find((region): region is string => !!region && /^[a-z0-9-]{1,32}$/.test(region)) ?? 'us-east-1';
}

export async function fetchKiroUsageLimits(
    accessToken: string,
    profileArn?: string,
    regions?: { apiRegion?: string; ssoRegion?: string },
): Promise<unknown> {
    const region = kiroUsageRegion(profileArn, regions);
    const url = new URL(`https://management.${region}.kiro.dev/`);
    url.searchParams.set('origin', 'AI_EDITOR');
    url.searchParams.set('isEmailRequired', 'true');
    if (profileArn) url.searchParams.set('profileArn', profileArn);

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/x-amz-json-1.0',
                Accept: 'application/json',
                'X-Amz-Target': 'AmazonCodeWhispererService.GetUsageLimits',
                'x-amzn-codewhisperer-optout': 'true',
            },
            body: JSON.stringify({ origin: 'AI_EDITOR', isEmailRequired: true, ...(profileArn ? { profileArn } : {}) }),
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
        });

        if (!resp.ok) void resp.body?.cancel().catch(() => undefined);
        if (resp.status === 401 || resp.status === 403) {
            return { authenticated: false, reason: 'kiro_token_expired' };
        }
        if (!resp.ok) return { error: true, reason: `kiro_usage_http_${resp.status}` };

        return await readQuotaJson(resp);
    } catch {
        return { error: true, reason: 'kiro_usage_fetch_failed' };
    }
}

async function readKiroWhoamiEmail(binary?: string): Promise<string | undefined> {
    const resolvedBinary = binary || detectCli('kiro-code').path;
    if (!resolvedBinary) return undefined;
    try {
        const { stdout } = await execFileAsync(resolvedBinary, ['whoami'], {
            encoding: 'utf8',
            timeout: 8000,
            env: { ...process.env, NO_COLOR: '1' },
        });
        const match = stdout.match(/([^\s@]+@[^\s@]+\.[^\s@]+)/);
        return match?.[1];
    } catch {
        return undefined;
    }
}

export async function fetchKiroUsage(binary?: string): Promise<QuotaRecord> {
    const resolvedBinary = binary || detectCli('kiro-code').path;
    const { token, profile, reason: authReason } = readKiroQuotaAuthFromStore();
    const profileArn = resolveKiroProfileArn(token, profile);

    if (!token?.accessToken) {
        return stripUndefined({
            authenticated: false,
            quotaCapable: false,
            quotaSource: 'kiro:auth-store-missing',
            reason: authReason,
            displayTier: 'Kiro',
            account: { type: 'kiro', tier: 'not logged in' },
            windows: [],
        });
    }

    const [usageResult, email] = await Promise.all([
        fetchKiroUsageLimits(token.accessToken, profileArn ?? undefined, token),
        readKiroWhoamiEmail(resolvedBinary || undefined),
    ]);

    if (asRecord(usageResult)?.['authenticated'] === false) {
        const reason = asRecord(usageResult)?.['reason'];
        return stripUndefined({
            authenticated: false,
            quotaCapable: false,
            quotaSource: 'kiro:codewhisperer-get-usage-limits',
            displayTier: 'Kiro',
            account: stripUndefined({
                type: 'kiro',
                tier: 'auth expired',
                email,
            }),
            windows: [],
            ...(typeof reason === 'string' ? { reason } : {}),
        });
    }

    if (asRecord(usageResult)?.['error']) {
        const reason = asRecord(usageResult)?.['reason'];
        return stripUndefined({
            authenticated: true,
            quotaCapable: false,
            quotaSource: 'kiro:codewhisperer-get-usage-limits',
            displayTier: 'Kiro',
            account: stripUndefined({
                type: 'kiro',
                tier: profile?.name || 'authenticated',
                email,
            }),
            windows: [],
            error: true,
            ...(typeof reason === 'string' ? { reason } : {}),
        });
    }

    const normalized = normalizeKiroUsageLimits(usageResult);
    return stripUndefined({
        ...normalized,
        account: {
            ...(asRecord(normalized['account']) || {}),
            email,
            profileArn,
        },
    });
}
