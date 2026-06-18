import { fetchKiroModelInventory } from '../agent/kiro-models.js';
import { discoverJwcAuthenticatedProviders, JWC_PROVIDER_EFFORT_DEFAULTS, JWC_PROVIDER_MODEL_DEFAULTS } from '../code-mode/model-options.js';
import { CLI_REGISTRY } from './registry.js';

async function fetchJwcProviders(): Promise<string[]> {
    try {
        return await discoverJwcAuthenticatedProviders();
    } catch {
        return [];
    }
}

export async function buildLiveCliRegistry() {
    const registry = structuredClone(CLI_REGISTRY) as Record<string, Record<string, unknown>>;

    const [kiroInventory, jwcProviders] = await Promise.all([
        fetchKiroModelInventory(),
        fetchJwcProviders(),
    ]);

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
