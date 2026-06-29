// ─── Argument Completions ────────────────────────────
// Extracted from handlers.ts for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './registry.js';
import { applyCodexModelsToChoices, resolveOpenCodexCodexModels } from './opencodex-models.js';
import { t } from '../core/i18n.js';
import type { CompletionCtx, SlashChoice } from './types.js';

const DEFAULT_CLI_CHOICES = [...CLI_KEYS];
const MODEL_LABEL_SKIP_CLIS = new Set(['ai-e']);

function toChoiceKey(value: unknown) {
    return String(value || '').trim().toLowerCase();
}

function dedupeChoices(list: SlashChoice[]): SlashChoice[] {
    const out: SlashChoice[] = [];
    const seen = new Set<string>();
    for (const entry of list || []) {
        const key = toChoiceKey(entry?.value ?? entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

function getCliChoicesFromContext(ctx: CompletionCtx): string[] {
    const keys = Object.keys(ctx?.settings?.perCli || {});
    return keys.length ? keys : DEFAULT_CLI_CHOICES;
}

async function getModelChoicesByCli(): Promise<Record<string, string[]>> {
    return applyCodexModelsToChoices(buildModelChoicesByCli(), await resolveOpenCodexCodexModels());
}

function getModelChoicesFromContext(ctx: CompletionCtx, modelChoicesByCli: Record<string, string[]>): string[] {
    const fromCatalog = (Object.values(modelChoicesByCli) as string[][]).flat();
    const perCli = (ctx?.settings?.perCli || {}) as Record<string, { model?: string } | undefined>;
    const fromSettings = Object.values(perCli)
        .map((v) => v?.model)
        .filter((m): m is string => Boolean(m));
    const activeCli = ctx?.settings?.cli || '';
    const currentModel = perCli[activeCli]?.model;
    const merged = [...fromCatalog, ...fromSettings, ...(currentModel ? [currentModel] : [])];
    return dedupeChoices(merged.map((value) => ({ value }))).map((c) => c.value);
}

export async function modelArgumentCompletions(ctx: CompletionCtx): Promise<SlashChoice[]> {
    const modelChoicesByCli = await getModelChoicesByCli();
    const cliByModel = new Map<string, string>();
    for (const [cli, models] of Object.entries(modelChoicesByCli)) {
        if (MODEL_LABEL_SKIP_CLIS.has(cli)) continue;
        for (const m of models as string[]) cliByModel.set(toChoiceKey(m), cli);
    }

    return getModelChoicesFromContext(ctx, modelChoicesByCli)
        .map((value) => ({
            value,
            label: cliByModel.get(toChoiceKey(value)) || 'custom',
        }));
}

export function cliArgumentCompletions(ctx: CompletionCtx): SlashChoice[] {
    return getCliChoicesFromContext(ctx)
        .map(value => ({ value, label: 'cli' }));
}

export function skillArgumentCompletions(ctx: CompletionCtx): SlashChoice[] {
    const L = ctx?.locale || 'ko';
    return [{ value: 'list', label: t('cmd.arg.skillList', {}, L) }, { value: 'reset', label: t('cmd.arg.skillReset', {}, L) }];
}

export function employeeArgumentCompletions(ctx: CompletionCtx): SlashChoice[] {
    const L = ctx?.locale || 'ko';
    return [
        { value: 'list', label: t('cmd.arg.employeeList', {}, L) },
        { value: 'info', label: t('cmd.arg.employeeInfo', {}, L) },
        { value: 'model', label: t('cmd.arg.employeeModel', {}, L) },
        { value: 'cli', label: t('cmd.arg.employeeCli', {}, L) },
        { value: 'reset', label: t('cmd.arg.employeeReset', {}, L) },
    ];
}

export function browserArgumentCompletions(ctx: CompletionCtx): SlashChoice[] {
    const L = ctx?.locale || 'ko';
    return [{ value: 'status', label: t('cmd.arg.browserStatus', {}, L) }, { value: 'tabs', label: t('cmd.arg.browserTabs', {}, L) }];
}

export function fallbackArgumentCompletions(ctx: CompletionCtx): SlashChoice[] {
    const L = ctx?.locale || 'ko';
    const clis = Object.keys(ctx?.settings?.perCli || {});
    return [
        ...clis.map(c => ({ value: c, label: 'cli' })),
        { value: 'off', label: t('cmd.arg.fallbackOff', {}, L) },
    ];
}

export async function flushArgumentCompletions(ctx: CompletionCtx): Promise<SlashChoice[]> {
    const L = ctx?.locale || 'ko';
    const clis = Object.keys(ctx?.settings?.perCli || {});
    const modelChoicesByCli = await getModelChoicesByCli();
    const allModels: string[] = (Object.values(modelChoicesByCli) as string[][]).flat();
    return dedupeChoices([
        ...clis.map(c => ({ value: c, label: 'cli' })),
        ...allModels.map(m => ({ value: m, label: 'model' })),
        { value: 'off', label: t('cmd.arg.flushOff', {}, L) },
    ]);
}
