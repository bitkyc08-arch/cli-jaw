import { join } from 'node:path';
import { homedir } from 'node:os';

export type JwcModelProvider = {
    id: string;
    models: string[];
    efforts: string[];
};

export type JwcModelOptions = {
    providers: JwcModelProvider[];
    defaultProvider: string;
    defaultModel: string;
    degraded?: boolean;
    error?: string;
};

export const JWC_PROVIDER_MODEL_DEFAULTS: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
    'openai-codex': ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    xai: ['grok-build', 'grok-composer-2.5-fast', 'grok-4.3'],
    cursor: ['composer-2.5', 'claude-sonnet-4-6', 'gpt-5.4'],
    'opencode-go': ['opencode-go/kimi-k2.6', 'opencode-go/glm-5.1'],
    google: ['gemini-3-flash-preview', 'gemini-2.5-pro'],
    deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    fireworks: ['accounts/fireworks/models/deepseek-v3'],
    groq: ['openai/gpt-oss-120b'],
};

export const JWC_PROVIDER_EFFORT_DEFAULTS: Record<string, string[]> = {
    anthropic: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
    'openai-codex': ['low', 'medium', 'high', 'xhigh'],
    xai: [],
    cursor: ['low', 'medium', 'high', 'xhigh'],
    'opencode-go': ['minimal', 'low', 'high', 'max'],
};

export async function discoverJwcAuthenticatedProviders(): Promise<string[]> {
    const sdk: { discoverAuthStorage(dir: string): Promise<{ list(): Promise<string[]> }> } =
        await (Function('return import("jawcode/sdk")')() as Promise<typeof sdk>);
    const auth = await sdk.discoverAuthStorage(
        process.env['CLI_JAW_JWC_AGENT_DIR'] || join(homedir(), '.jwc', 'agent'),
    );
    const providers = await auth.list();
    return Array.isArray(providers)
        ? providers.filter((provider): provider is string => typeof provider === 'string' && provider.length > 0)
        : [];
}

export async function resolveJwcModelOptions(): Promise<JwcModelOptions> {
    try {
        const authenticated = await discoverJwcAuthenticatedProviders();
        const providerIds = authenticated.length > 0 ? authenticated : ['anthropic'];
        const providers = providerIds.map(id => ({
            id,
            models: JWC_PROVIDER_MODEL_DEFAULTS[id] ?? [],
            efforts: JWC_PROVIDER_EFFORT_DEFAULTS[id] ?? [],
        }));
        const defaultProvider = providerIds.includes('anthropic') ? 'anthropic' : providerIds[0] ?? 'anthropic';
        const defaultModel = JWC_PROVIDER_MODEL_DEFAULTS[defaultProvider]?.[0] ?? '';
        return {
            providers,
            defaultProvider,
            defaultModel,
            ...(authenticated.length === 0 ? { degraded: true, error: 'No authenticated JWC providers found; using Anthropic defaults.' } : {}),
        };
    } catch (err) {
        return {
            providers: [{
                id: 'anthropic',
                models: JWC_PROVIDER_MODEL_DEFAULTS['anthropic'] ?? [],
                efforts: JWC_PROVIDER_EFFORT_DEFAULTS['anthropic'] ?? [],
            }],
            defaultProvider: 'anthropic',
            defaultModel: JWC_PROVIDER_MODEL_DEFAULTS['anthropic']?.[0] ?? '',
            degraded: true,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
