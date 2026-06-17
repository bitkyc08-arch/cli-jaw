import { fetchKiroModelInventory } from '../agent/kiro-models.js';
import { CLI_REGISTRY } from './registry.js';

async function fetchJwcProviders(): Promise<string[]> {
    try {
        // Dynamic import avoids tsc following jawcode source tree (moduleResolution mismatch).
        const sdk: { discoverAuthStorage(dir: string): Promise<{ list(): Promise<string[]> }> } =
            await (Function('return import("jawcode/sdk")')() as Promise<typeof sdk>);
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const auth = await sdk.discoverAuthStorage(
            process.env['CLI_JAW_JWC_AGENT_DIR'] || join(homedir(), '.jwc', 'agent'),
        );
        const providers = await auth.list();
        return Array.isArray(providers) ? providers.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    } catch {
        return [];
    }
}

const PROVIDER_MODEL_DEFAULTS: Record<string, string[]> = {
    anthropic: ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    'openai-codex': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    xai: ['grok-build', 'grok-composer-2.5-fast', 'grok-4.3'],
    cursor: ['composer-2.5', 'claude-sonnet-4-6', 'gpt-5.5'],
    'opencode-go': ['opencode-go/kimi-k2.6', 'opencode-go/glm-5.1'],
    google: ['gemini-3-flash-preview', 'gemini-2.5-pro'],
    deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    fireworks: ['accounts/fireworks/models/deepseek-v3'],
    groq: ['openai/gpt-oss-120b'],
};

const PROVIDER_EFFORT_DEFAULTS: Record<string, string[]> = {
    anthropic: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
    'openai-codex': ['low', 'medium', 'high', 'xhigh'],
    xai: [],
    cursor: ['low', 'medium', 'high', 'xhigh'],
    'opencode-go': ['minimal', 'low', 'high', 'max'],
};

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
        for (const p of jwcProviders) {
            modelsByProvider[p] = PROVIDER_MODEL_DEFAULTS[p] || [];
            effortsByProvider[p] = PROVIDER_EFFORT_DEFAULTS[p] || [];
            allModels.push(...modelsByProvider[p]);
        }
        registry['jwc'] = {
            ...registry['jwc'],
            providers: jwcProviders,
            modelsByProvider,
            effortsByProvider,
            models: allModels.length > 0 ? allModels : registry['jwc']?.['models'],
            defaultProvider: jwcProviders.includes('anthropic') ? 'anthropic' : jwcProviders[0],
        };
    }

    return registry;
}
