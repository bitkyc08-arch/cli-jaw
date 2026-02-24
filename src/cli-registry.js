// ─── CLI Registry (single source of truth) ──────────

export const CLI_REGISTRY = {
    claude: {
        label: 'Claude',
        binary: 'claude',
        defaultModel: 'claude-sonnet-4-6',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high'],
        models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-6[1m]', 'claude-opus-4-6[1m]', 'claude-haiku-4-5-20251001'],
    },
    codex: {
        label: 'Codex',
        binary: 'codex',
        defaultModel: 'gpt-5.3-codex',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    },
    gemini: {
        label: 'Gemini',
        binary: 'gemini',
        defaultModel: 'gemini-2.5-pro',
        defaultEffort: '',
        efforts: [],
        models: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    },
    opencode: {
        label: 'OpenCode',
        binary: 'opencode',
        defaultModel: 'anthropic/claude-opus-4-6-thinking',
        defaultEffort: '',
        efforts: ['minimal', 'low', 'high', 'max'],
        models: [
            'anthropic/claude-opus-4-6-thinking',
            'anthropic/claude-sonnet-4-6-thinking',
            'anthropic/claude-sonnet-4-6',
            'openai/gpt-5.3-codex-xhigh',
            'openai/gpt-5.3-codex-high',
            'opencode/big-pickle',
            'opencode/GLM-5 Free',
            'opencode/MiniMax M2.5 Free',
            'opencode/Kimi K2.5 Free',
            'opencode/GPT 5 Nano Free',
            'opencode/Grok Code Fast 1 Free',
        ],
    },
    copilot: {
        label: 'Copilot',
        binary: 'copilot',
        defaultModel: 'claude-sonnet-4.6',
        defaultEffort: 'high',
        efforts: ['low', 'medium', 'high'],
        models: [
            'claude-sonnet-4.6',
            'claude-opus-4.6',
            'claude-haiku-4.5',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex',
            'gpt-4.1',
            'gpt-5-mini',
            'gemini-3-pro-preview',
        ],
    },
};

export const CLI_KEYS = Object.keys(CLI_REGISTRY);
export const DEFAULT_CLI = CLI_KEYS.includes('claude') ? 'claude' : CLI_KEYS[0];

export function buildDefaultPerCli() {
    const out = {};
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key];
        out[key] = {
            model: entry.defaultModel,
            effort: entry.defaultEffort || '',
        };
    }
    return out;
}

export function buildModelChoicesByCli() {
    const out = {};
    for (const key of CLI_KEYS) out[key] = [...(CLI_REGISTRY[key].models || [])];
    return out;
}
