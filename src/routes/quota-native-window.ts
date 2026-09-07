/** Native quota parsers adapted from OpenCodex src/codex/quota.ts and
 * src/providers/quota.ts at b94051fe91e745806102988f6dff2fec8de078ef.
 * MIT; see LICENSE. Native DTO labels and credential ownership remain cli-jaw specific.
 */
import { asQuotaRecord as record, quotaNumber, quotaPercent as percent, quotaResetIso } from './quota-wire.js';

type RecordValue = Record<string, unknown>;
export interface NativeQuotaWindow {
    label: string;
    percent: number;
    resetsAt: string | null;
}
export interface NativeUsageWindows {
    windows: NativeQuotaWindow[];
    resetCredits?: number;
}

function codexReset(value: unknown): string | null {
    const seconds = quotaNumber(value);
    if (seconds === undefined || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? quotaResetIso(date.toISOString()) : null;
}
function duration(window: RecordValue | null): number | undefined {
    const seconds = window?.['limit_window_seconds'];
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : undefined;
}
function short(window: RecordValue | null): boolean {
    const seconds = duration(window);
    return seconds !== undefined && seconds > 0 && seconds < 86400;
}
function monthly(window: RecordValue | null): boolean {
    const seconds = duration(window);
    return seconds !== undefined && seconds >= 2419200;
}
function shortLabel(seconds: number): string {
    if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
    if (seconds % 60 === 0) return `${seconds / 60}-minute`;
    return `${seconds}-second`;
}
function appendCodex(out: NativeQuotaWindow[], label: string, window: RecordValue | null): void {
    const usage = percent(window?.['used_percent']);
    if (usage !== undefined) out.push({ label, percent: usage, resetsAt: codexReset(window?.['reset_at']) });
}

export function parseCodexUsageWindows(payload: unknown): NativeUsageWindows | null {
    const body = record(payload);
    if (!body) return null;
    const rate = record(body['rate_limit']);
    const primary = record(rate?.['primary_window']);
    const secondary = record(rate?.['secondary_window']);
    const tertiary = record(rate?.['tertiary_window']);
    const primaryUsage = percent(primary?.['used_percent']);
    const primaryShort = short(primary);
    const primaryMonthly = monthly(primary);
    const plan = typeof body['plan_type'] === 'string' ? body['plan_type'].trim().toLowerCase() : '';
    const monthlyOnly = plan === 'go' || plan === 'free';
    const windows: NativeQuotaWindow[] = [];
    if (primaryShort) appendCodex(windows, shortLabel(duration(primary)!), primary);
    const weekly = primaryMonthly || primaryShort || primaryUsage === undefined ? secondary : primary;
    const month = primaryMonthly && primaryUsage !== undefined ? primary : tertiary;
    if (!monthlyOnly) appendCodex(windows, '7-day', weekly);
    appendCodex(windows, '30-day', month);
    const additional = Array.isArray(body['additional_rate_limits']) ? body['additional_rate_limits'] : [];
    const spark = additional.map(record).find(entry => {
        const name = String(entry?.['limit_name'] ?? '').toLowerCase();
        const feature = String(entry?.['metered_feature'] ?? '').toLowerCase();
        return feature === 'codex_bengalfox' || name.includes('gpt-5.3-codex-spark');
    });
    const sparkRate = record(spark?.['rate_limit']);
    const sparkWeekly = [record(sparkRate?.['primary_window']), record(sparkRate?.['secondary_window'])]
        .find(window => window !== null && percent(window['used_percent']) !== undefined
            && !short(window) && !monthly(window)
            && (window['limit_window_seconds'] === undefined
                || (typeof window['limit_window_seconds'] === 'number'
                    && Number.isFinite(window['limit_window_seconds'])
                    && window['limit_window_seconds'] >= 86400)));
    appendCodex(windows, 'GPT-5.3-Codex-Spark Weekly', sparkWeekly ?? null);
    const credits = record(body['rate_limit_reset_credits'])?.['available_count'];
    const resetCredits = typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
        ? credits : undefined;
    if (!windows.length && resetCredits === undefined) return null;
    return { windows, ...(resetCredits !== undefined ? { resetCredits } : {}) };
}

function modelLabel(name: string): string {
    const lower = name.toLowerCase();
    return lower.includes('fable') ? 'Fable' : lower.includes('opus') ? 'Opus'
        : lower.includes('sonnet') ? 'Sonnet' : name;
}
export function parseClaudeUsageWindows(payload: unknown): NativeUsageWindows | null {
    const body = record(payload);
    if (!body) return null;
    const windows: NativeQuotaWindow[] = [];
    const knownModels = new Set<string>();
    for (const [key, label, model] of [
        ['five_hour', '5-hour', ''], ['seven_day', '7-day', ''],
        ['seven_day_sonnet', '7-day Sonnet', 'Sonnet'],
        ['seven_day_opus', '7-day Opus', 'Opus'],
        ['seven_day_fable', '7-day Fable', 'Fable'],
    ] as const) {
        const bucket = record(body[key]);
        const usage = percent(bucket?.['utilization']);
        if (usage === undefined) continue;
        windows.push({ label, percent: usage, resetsAt: quotaResetIso(bucket?.['resets_at']) });
        if (model) knownModels.add(model.toLowerCase());
    }
    const limits = Array.isArray(body['limits']) ? body['limits'] : [];
    for (const value of limits) {
        const limit = record(value);
        if (String(limit?.['kind'] ?? '').trim().toLowerCase() !== 'weekly_scoped') continue;
        const model = record(record(limit?.['scope'])?.['model']);
        const rawLabel = String(model?.['display_name'] ?? '').trim();
        const usage = percent(limit?.['percent']);
        if (!rawLabel || usage === undefined) continue;
        const label = modelLabel(rawLabel);
        if (knownModels.has(label.toLowerCase())) continue;
        knownModels.add(label.toLowerCase());
        windows.push({ label: `7-day ${label}`, percent: usage, resetsAt: quotaResetIso(limit?.['resets_at']) });
    }
    return windows.length ? { windows } : null;
}
