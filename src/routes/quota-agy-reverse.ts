// Reverse-engineered Antigravity / AGY quota reader.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stripUndefined } from '../core/strip-undefined.js';
import { fetchGeminiUsage, readGeminiAccount } from './quota.js';

const execFileAsync = promisify(execFile);

type QuotaRecord = Record<string, unknown>;

interface AntigravityModelQuota {
    label?: string;
    modelId?: string;
    remainingPercentage?: number;
    isExhausted?: boolean;
    resetTime?: string;
    isAutocompleteOnly?: boolean;
}

interface AntigravityQuotaSnapshot {
    method?: string;
    email?: string;
    planType?: string;
    models?: AntigravityModelQuota[];
}

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
    const quotaModels = models.filter((model) => (
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
    for (const model of models) {
        if (model.isAutocompleteOnly) continue;
        const family = classifyAgyQuotaFamily(model);
        if (!family || buckets.has(family)) continue;
        // Antigravity quota pools are linked per family; any model in the pool shows the same value.
        buckets.set(family, stripUndefined({
            label: family === 'gem' ? 'Gem' : 'Cla',
            percent: usedPercentFromRemaining(model.remainingPercentage, model.isExhausted),
            resetsAt: model.resetTime ?? null,
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
    const models = Array.isArray(snapshot.models) ? snapshot.models : [];
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

async function runAntigravityUsageJson(): Promise<AntigravityQuotaSnapshot | null> {
    const commands: Array<[string, string[]]> = [
        ['antigravity-usage', ['--json']],
        ['npx', ['--yes', 'antigravity-usage', '--json']],
    ];
    for (const [binary, args] of commands) {
        try {
            const { stdout } = await execFileAsync(binary, args, {
                encoding: 'utf8',
                timeout: 15000,
            });
            const out = stdout.trim();
            if (!out.startsWith('{')) continue;
            return JSON.parse(out) as AntigravityQuotaSnapshot;
        } catch {
            continue;
        }
    }
    return null;
}

function buildAgyStatusOnly(): QuotaRecord {
    return stripUndefined({
        authenticated: true,
        quotaCapable: false,
        quotaSource: 'not-exposed-by-agy-cli',
        displayTier: 'Antigravity',
        account: { type: 'antigravity.google', tier: 'runtime-checked' },
        windows: [],
        reverseEngineered: false,
    });
}

export async function fetchAgyUsage(): Promise<QuotaRecord> {
    const snapshot = await runAntigravityUsageJson();
    if (snapshot?.models?.length) {
        return normalizeAntigravityUsageSnapshot(snapshot);
    }

    const geminiAccount = readGeminiAccount();
    if (geminiAccount) {
        const geminiUsage = await fetchGeminiUsage(geminiAccount);
        if (geminiUsage && !geminiUsage.error && Array.isArray(geminiUsage.windows) && geminiUsage.windows.length > 0) {
            return stripUndefined({
                ...geminiUsage,
                quotaCapable: true,
                quotaSource: 'agy:google-cloud-code-api',
                displayTier: 'Antigravity',
                account: stripUndefined({
                    type: 'antigravity.google',
                    email: geminiUsage.account?.email,
                }),
                reverseEngineered: true,
            });
        }
        if (geminiUsage?.authenticated === false) {
            return stripUndefined({
                ...buildAgyStatusOnly(),
                authenticated: false,
            });
        }
    }

    return buildAgyStatusOnly();
}
