import { fetchKiroModelInventory } from '../agent/kiro-models.js';
import { discoverJwcAuthenticatedProviders, JWC_PROVIDER_EFFORT_DEFAULTS, JWC_PROVIDER_MODEL_DEFAULTS } from '../code-mode/model-options.js';
import { CLI_REGISTRY } from './registry.js';
import { resolveOpenCodexCodexModelsDetailed } from './opencodex-models.js';

async function fetchJwcProviders(): Promise<string[]> {
    try {
        return await discoverJwcAuthenticatedProviders();
    } catch {
        return [];
    }
}

/** Union of every per-model effort set, first-seen order preserved. */
function unionEfforts(effortsByModel: Record<string, string[]>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const efforts of Object.values(effortsByModel)) {
        for (const effort of efforts) {
            if (seen.has(effort)) continue;
            seen.add(effort);
            out.push(effort);
        }
    }
    return out;
}

export async function buildLiveCliRegistry() {
    const registry = structuredClone(CLI_REGISTRY) as Record<string, Record<string, unknown>>;

    const [kiroInventory, jwcProviders, codexResult] = await Promise.all([
        fetchKiroModelInventory(),
        fetchJwcProviders(),
        resolveOpenCodexCodexModelsDetailed(),
    ]);

    const codexModels = codexResult.models;
    if (codexModels.length > 0) {
        // Per-model effort metadata. opencodex advertises a DIFFERENT effort set
        // per model (gpt-5.6-sol reaches `ultra`, gpt-5.6-luna stops at `max`,
        // routed models like anthropic/* take none), and the chosen value is
        // forwarded to the wire, so consumers must narrow by model rather than
        // offer the union. `efforts` stays as the union for legacy consumers.
        const effortsByModel: Record<string, string[]> = {};
        const defaultEffortByModel: Record<string, string> = {};
        for (const entry of codexResult.entries) {
            effortsByModel[entry.id] = [...entry.efforts];
            if (entry.defaultEffort) defaultEffortByModel[entry.id] = entry.defaultEffort;
        }
        const merged = unionEfforts(effortsByModel);
        const codexPatch: Record<string, unknown> = {
            models: codexModels,
            modelSource: codexResult.source,
            effortsByModel,
            defaultEffortByModel,
            // Never widen to an empty list: an all-routed catalog would otherwise
            // strip the picker for every model at once.
            ...(merged.length > 0 ? { efforts: merged } : {}),
        };
        // `defaultModel`/`defaultEffort` stay static on purpose: buildDefaultPerCli()
        // seeds user settings from them, so live routing order must not silently
        // rewrite a user's default runtime.
        registry['codex'] = { ...registry['codex'], ...codexPatch };
        registry['codex-app'] = { ...registry['codex-app'], ...codexPatch };
        const aiE = registry['ai-e'];
        if (aiE) {
            const existingModelsByProvider = (aiE['modelsByProvider'] as Record<string, string[]> | undefined) || {};
            const modelsByProvider: Record<string, string[]> = {
                ...existingModelsByProvider,
                codex: codexModels,
            };
            const existingEffortsByProvider = (aiE['effortsByProvider'] as Record<string, string[]> | undefined) || {};
            const effortsByProvider: Record<string, string[]> = merged.length > 0
                ? { ...existingEffortsByProvider, codex: merged }
                : existingEffortsByProvider;
            const providers = Array.isArray(aiE['providers']) ? aiE['providers'] as string[] : Object.keys(modelsByProvider);
            // ai-e splits models by provider, so per-model efforts MUST be
            // provider-scoped. A flat map collides on shared ids: `gpt-5.6-sol`
            // exists under both codex and kiro, but Kiro only accepts
            // low/medium/high/xhigh (args.ts KIRO_EFFORTS) while ocx advertises
            // max/ultra for the codex route. A flat map offered `ultra` to Kiro.
            const existingEffortsByModelByProvider =
                (aiE['effortsByModelByProvider'] as Record<string, Record<string, string[]>> | undefined) || {};
            const existingDefaultEffortByModelByProvider =
                (aiE['defaultEffortByModelByProvider'] as Record<string, Record<string, string>> | undefined) || {};
            registry['ai-e'] = {
                ...aiE,
                modelsByProvider,
                effortsByProvider,
                effortsByModelByProvider: { ...existingEffortsByModelByProvider, codex: effortsByModel },
                defaultEffortByModelByProvider: { ...existingDefaultEffortByModelByProvider, codex: defaultEffortByModel },
                models: providers.flatMap(provider => modelsByProvider[provider] || []),
            };
        }
    }

    if (kiroInventory?.models.length) {
        registry['kiro-code'] = {
            ...registry['kiro-code'],
            models: kiroInventory.models,
            defaultModel: kiroInventory.defaultModel,
            modelSource: kiroInventory.source,
            modelDetails: kiroInventory.entries,
        };
    }

    if (jwcProviders.length > 0) {
        const modelsByProvider: Record<string, string[]> = {};
        const effortsByProvider: Record<string, string[]> = {};
        const allModels: string[] = [];
        const defaultProvider = jwcProviders.includes('anthropic') ? 'anthropic' : (jwcProviders[0] ?? 'anthropic');
        for (const p of jwcProviders) {
            modelsByProvider[p] = JWC_PROVIDER_MODEL_DEFAULTS[p] || [];
            effortsByProvider[p] = JWC_PROVIDER_EFFORT_DEFAULTS[p] || [];
            allModels.push(...modelsByProvider[p]);
        }
        registry['jwc'] = {
            ...registry['jwc'],
            providers: jwcProviders,
            modelsByProvider,
            effortsByProvider,
            models: allModels.length > 0 ? allModels : registry['jwc']?.['models'],
            defaultProvider,
            defaultModel: modelsByProvider[defaultProvider]?.[0] ?? registry['jwc']?.['defaultModel'],
        };
    }

    return registry;
}
