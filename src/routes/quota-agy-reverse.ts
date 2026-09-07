// Reverse-engineered Antigravity / AGY quota reader.

import { stripUndefined } from '../core/strip-undefined.js';
import { asQuotaRecord, quotaNumber, quotaPercent, quotaResetIso, readQuotaJson } from './quota-wire.js';
import { readAgyGoogleContext, loadAgyProject, agyQuotaUserAgent } from './quota-agy-auth.js';
import type { AgyGoogleContextResult } from './quota-agy-auth.js';
import { readAgyLocalSnapshot } from './quota-agy-local.js';
import type { AntigravityModelQuota, AntigravityQuotaSnapshot } from './quota-agy-local.js';

type QuotaRecord = Record<string, unknown>;
type NativeWindow = { label: string; percent: number; resetsAt: string | null };
type NativeResult = { windows: NativeWindow[]; source: string } | { failure: 'auth' | 'redirect' | 'unavailable' };

function usedPercentFromRemaining(remaining?: number, exhausted?: boolean): number {
    if (exhausted) return 100;
    if (remaining == null || !Number.isFinite(remaining)) return 0;
    // antigravity-usage can currently degrade to binary remaining values.
    // Preserve precise fractions when available, but map binary 1/0 to 0%/100% used.
    if (remaining === 1) return 0;
    if (remaining === 0) return 100;
    return Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)));
}

type AgyQuotaFamily = 'gem' | 'cla';

function classifyAgyQuotaFamily(model: AntigravityModelQuota): AgyQuotaFamily | null {
    const haystack = `${model.label || ''} ${model.modelId || ''}`.toLowerCase();
    if (haystack.includes('gemini')) return 'gem';
    if (
        haystack.includes('claude')
        || haystack.includes('opus')
        || haystack.includes('sonnet')
        || haystack.includes('gpt-oss')
        || haystack.includes('gpt_oss')
    ) {
        return 'cla';
    }
    return null;
}

export function collapseAgyQuotaWindows(models: AntigravityModelQuota[]) {
    const validModels = (Array.isArray(models) ? models : []).filter(model => asQuotaRecord(model));
    const quotaModels = validModels.filter((model) => (
        !model.isAutocompleteOnly
        && classifyAgyQuotaFamily(model) !== null
        && model.remainingPercentage != null
        && Number.isFinite(model.remainingPercentage)
    ));
    const binaryOnly = quotaModels.length > 0 && quotaModels.every((model) => (
        model.remainingPercentage === 0 || model.remainingPercentage === 1
    ));
    const buckets = new Map<AgyQuotaFamily, {
        label: string;
        percent: number;
        resetsAt: string | null;
        modelId?: string;
        precision?: 'binary';
        status?: 'available' | 'exhausted';
    }>();
    for (const model of validModels) {
        if (model.isAutocompleteOnly || (!Number.isFinite(model.remainingPercentage) && model.isExhausted !== true)) continue;
        const family = classifyAgyQuotaFamily(model);
        if (!family || buckets.has(family)) continue;
        // Antigravity quota pools are linked per family; any model in the pool shows the same value.
        buckets.set(family, stripUndefined({
            label: family === 'gem' ? 'Gem' : 'Cla',
            percent: usedPercentFromRemaining(model.remainingPercentage, model.isExhausted),
            resetsAt: quotaResetIso(model.resetTime),
            modelId: model.modelId,
            precision: binaryOnly ? 'binary' : undefined,
            status: binaryOnly
                ? (model.isExhausted || model.remainingPercentage === 0 ? 'exhausted' : 'available')
                : undefined,
        }));
    }
    return (['gem', 'cla'] as const).flatMap((family) => {
        const window = buckets.get(family);
        return window ? [window] : [];
    });
}

export function normalizeAntigravityUsageSnapshot(snapshot: AntigravityQuotaSnapshot): QuotaRecord {
    const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
    snapshot = asQuotaRecord(snapshot) ? snapshot : {};
    const windows = collapseAgyQuotaWindows(models);

    return stripUndefined({
        authenticated: true,
        quotaCapable: windows.length > 0,
        quotaSource: `agy:antigravity-usage:${snapshot.method || 'auto'}`,
        displayTier: snapshot.planType ? `Antigravity ${snapshot.planType}` : 'Antigravity',
        account: stripUndefined({
            type: 'antigravity.google',
            tier: snapshot.planType,
            email: snapshot.email,
        }),
        windows,
        reverseEngineered: true,
    });
}

// Native Google parsers adapted from OpenCodex providers/quota.ts,
// b94051fe91e745806102988f6dff2fec8de078ef (MIT; see LICENSE).
function nativeUsed(row: QuotaRecord): number | undefined {
    const target = asQuotaRecord(row['remaining']) ?? row;
    const fraction = quotaNumber(target['remainingFraction']) ?? quotaNumber(target['remainingPercentage']);
    if (fraction === undefined) return undefined;
    const remaining = quotaPercent(fraction * 100);
    return remaining === undefined ? undefined : quotaPercent(100 - remaining);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function summaryWindows(value: unknown): NativeWindow[] {
    const groups = asQuotaRecord(value)?.['groups'];
    if (!Array.isArray(groups)) return [];
    const windows = new Map<string, NativeWindow>();
    const order = ['Gem', 'Gem (Weekly)', 'Cla', 'Cla (Weekly)'];
    for (const value of groups) {
        const group = asQuotaRecord(value);
        if (!group || !Array.isArray(group['buckets'])) continue;
        const name = `${text(group['displayName'])} ${text(group['description'])}`.toLowerCase();
        const family = name.includes('gemini') ? 'Gem' : /claude|3p|gpt/.test(name) ? 'Cla' : null;
        for (const value of group['buckets']) {
            const bucket = asQuotaRecord(value);
            if (!bucket) continue;
            const percent = nativeUsed(bucket);
            if (percent === undefined) continue;
            const window = `${text(bucket['window'])} ${text(bucket['bucketId'])} ${text(bucket['displayName'])}`.toLowerCase();
            const weekly = window.includes('week');
            const five = /5h|five/.test(window);
            const label = family ? (five ? family : weekly ? `${family} (Weekly)` : '')
                : (text(group['displayName']) || 'Other') + (weekly ? ' (Weekly)' : '');
            if (label && !windows.has(label)) windows.set(label, { label, percent, resetsAt: quotaResetIso(bucket['resetTime']) });
        }
    }
    return [...windows.values()].sort((a, b) => {
        const ai = order.indexOf(a.label); const bi = order.indexOf(b.label);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return a.label.localeCompare(b.label);
    });
}

function modelWindows(value: unknown): NativeWindow[] {
    const models = asQuotaRecord(asQuotaRecord(value)?.['models']);
    if (!models) return [];
    const windows = new Map<AgyQuotaFamily, NativeWindow>();
    for (const [modelId, value] of Object.entries(models)) {
        const model = asQuotaRecord(value);
        if (!model) continue;
        const entries: QuotaRecord[] = [];
        const add = (value: unknown, tier?: string) => {
            for (const entry of Array.isArray(value) ? value : [value]) {
                const row = asQuotaRecord(entry);
                if (row) entries.push(tier ? { ...row, tier } : row);
            }
        };
        add(model['quotaInfo']); add(model['quotaInfos']);
        for (const [tier, value] of Object.entries(asQuotaRecord(model['quotaInfoByTier']) ?? {})) add(value, tier);
        for (const row of entries) {
            const family = classifyAgyQuotaFamily({ modelId, label: `${text(model['displayName'])} ${text(row['tier'])}` });
            const percent = nativeUsed(row);
            if (!family || windows.has(family) || percent === undefined) continue;
            windows.set(family, { label: family === 'gem' ? 'Gem' : 'Cla', percent, resetsAt: quotaResetIso(row['resetTime']) });
        }
    }
    return (['gem', 'cla'] as const).flatMap(family => windows.has(family) ? [windows.get(family)!] : []);
}

async function googleQuotaRequest(method: 'retrieveUserQuotaSummary' | 'fetchAvailableModels', accessToken: string, projectId: string): Promise<NativeResult> {
    try {
        const response = await fetch(`https://daily-cloudcode-pa.googleapis.com/v1internal:${method}`, {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
            headers: { Accept: 'application/json', 'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`, 'User-Agent': agyQuotaUserAgent() },
            body: JSON.stringify({ project: projectId }),
        });
        if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            if (response.status >= 300 && response.status < 400) return { failure: 'redirect' };
            return { failure: response.status === 401 || response.status === 403 ? 'auth' : 'unavailable' };
        }
        const data = await readQuotaJson(response);
        const windows = method === 'retrieveUserQuotaSummary' ? summaryWindows(data) : modelWindows(data);
        return windows.length ? { windows, source: `agy:${method}` } : { failure: 'unavailable' };
    } catch { return { failure: 'unavailable' }; }
}

async function fetchAgyNativeQuota(context: Extract<AgyGoogleContextResult, { kind: 'ready' }>): Promise<NativeResult> {
    let projectId = context.projectId;
    if (!projectId) {
        const project = await loadAgyProject(context.accessToken);
        if ('failure' in project) return project;
        projectId = project.projectId;
    }
    const summary = await googleQuotaRequest('retrieveUserQuotaSummary', context.accessToken, projectId);
    return 'failure' in summary && summary.failure === 'unavailable'
        ? googleQuotaRequest('fetchAvailableModels', context.accessToken, projectId) : summary;
}

function statusOnly(reason: string, authenticated?: boolean): QuotaRecord {
    return { quotaCapable: false, quotaSource: 'agy:native', displayTier: 'Antigravity',
        account: { type: 'antigravity.google' }, windows: [], reason,
        ...(authenticated === undefined ? { error: true } : { authenticated }) };
}

export async function fetchAgyUsage(): Promise<QuotaRecord> {
    const selected = readAgyGoogleContext();
    const local = await readAgyLocalSnapshot();
    // A local redirect must not turn into another endpoint/account fallback.
    if (local.kind === 'unavailable' && local.reason === 'agy_local_redirect_rejected') return statusOnly(local.reason);
    const snapshot = local.kind === 'snapshot' && local.authenticated !== false ? local.snapshot : undefined;
    const sameAccount = !!snapshot?.email?.trim() && selected.kind === 'ready' && !!selected.email
        && snapshot.email.trim().toLowerCase() === selected.email.trim().toLowerCase();
    if (snapshot && !sameAccount) return normalizeAntigravityUsageSnapshot(snapshot);
    if (selected.kind !== 'ready') return statusOnly(selected.reason, false);
    const native = await fetchAgyNativeQuota(selected);
    if ('failure' in native) {
        if (native.failure === 'auth') return statusOnly('agy_token_expired', false);
        if (native.failure === 'redirect') return statusOnly('agy_redirect_rejected');
        return snapshot ? normalizeAntigravityUsageSnapshot(snapshot) : statusOnly('agy_usage_unavailable');
    }
    return {
        authenticated: true, quotaCapable: true, quotaSource: native.source,
        displayTier: snapshot?.planType ? `Antigravity ${snapshot.planType}` : 'Antigravity',
        account: stripUndefined({ type: 'antigravity.google', email: selected.email, tier: snapshot?.planType }),
        windows: native.windows, reverseEngineered: true,
    };
}
