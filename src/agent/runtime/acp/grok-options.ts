import { normalizeNativePermissions } from './permissions.js';
import { acpRecord } from './session.js';

/** Jaw's literal auto policy is always-approve, not Grok's classifier-based auto. */
export function grokAcpArgs(value: unknown): string[] {
    const permissions = normalizeNativePermissions(value);
    return permissions === 'auto'
        ? ['agent', '--no-leader', '--always-approve', 'stdio']
        : ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'];
}

/** Select an existing login mechanism; never silently change auth identity. */
export function grokAuthMethod(environment: NodeJS.ProcessEnv, advertised: unknown): string {
    const method = environment['XAI_API_KEY']?.trim() ? 'xai.api_key' : 'cached_token';
    if (!Array.isArray(advertised) || !advertised.some(entry => entry && typeof entry === 'object'
        && !Array.isArray(entry) && entry['id'] === method)) throw new Error('grok_existing_auth_unavailable');
    return method;
}

function identifier(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('grok_invalid_model_metadata');
    return value;
}

/** Grok 1.0.13 advertises legacy models, with object-valued reasoningEfforts. */
export function grokModelSelection(setup: unknown, requested?: string | null, effort?: string | null): {
    modelId: string; meta?: { reasoningEffort: string };
} {
    const state = acpRecord(acpRecord(setup)['models']);
    const current = identifier(state['currentModelId']);
    const raw = state['availableModels'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2048) throw new Error('grok_invalid_model_metadata');
    const models = new Map<string, Record<string, unknown>>();
    for (const entry of raw) {
        const model = acpRecord(entry), id = identifier(model['modelId']);
        if (models.has(id)) throw new Error('grok_ambiguous_model');
        models.set(id, model);
    }
    if (!models.has(current)) throw new Error('grok_invalid_model_metadata');
    const modelId = !requested || requested === 'default' || requested === 'grok-build' ? current : identifier(requested);
    const selected = models.get(modelId);
    if (!selected) throw new Error('grok_model_not_advertised');
    if (!effort) return { modelId };
    identifier(effort);
    const meta = acpRecord(selected['_meta']);
    const choices = meta['reasoningEfforts'];
    if (meta['supportsReasoningEffort'] !== true || !Array.isArray(choices) || choices.length > 64) {
        throw new Error('grok_effort_unavailable');
    }
    const values = new Set<string>();
    for (const entry of choices) {
        const value = identifier(acpRecord(entry)['value']);
        if (values.has(value)) throw new Error('grok_ambiguous_effort');
        values.add(value);
    }
    if (!values.has(effort)) throw new Error('grok_effort_unavailable');
    return { modelId, meta: { reasoningEffort: effort } };
}
