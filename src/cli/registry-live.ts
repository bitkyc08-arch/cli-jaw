import { fetchKiroModelInventory } from '../agent/kiro-models.js';
import { CLI_REGISTRY } from './registry.js';
import { resolveOpenCodexCodexModels } from './opencodex-models.js';

export async function buildLiveCliRegistry() {
    const registry = structuredClone(CLI_REGISTRY) as Record<string, Record<string, unknown>>;

    const [kiroInventory, codexModels] = await Promise.all([
        fetchKiroModelInventory(),
        resolveOpenCodexCodexModels(),
    ]);

    if (codexModels.length > 0) {
        registry['codex'] = { ...registry['codex'], models: codexModels };
        registry['codex-app'] = { ...registry['codex-app'], models: codexModels };
        const aiE = registry['ai-e'];
        if (aiE) {
            const existingModelsByProvider = (aiE['modelsByProvider'] as Record<string, string[]> | undefined) || {};
            const modelsByProvider: Record<string, string[]> = {
                ...existingModelsByProvider,
                codex: codexModels,
            };
            const providers = Array.isArray(aiE['providers']) ? aiE['providers'] as string[] : Object.keys(modelsByProvider);
            registry['ai-e'] = {
                ...aiE,
                modelsByProvider,
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

    return registry;
}
