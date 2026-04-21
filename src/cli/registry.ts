// ─── CLI Registry (single source of truth) ──────────

import { getDefaultClaudeChoices, getDefaultClaudeModel } from './claude-models.js';

export const CLI_REGISTRY = {
    claude: {
        label: 'Claude',
        binary: 'claude',
        defaultModel: getDefaultClaudeModel(),
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        models: getDefaultClaudeChoices(),
    },
    codex: {
        label: 'Codex',
        binary: 'codex',
        defaultModel: 'gpt-5.4',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    },
    gemini: {
        label: 'Gemini',
        binary: 'gemini',
        defaultModel: 'gemini-3-flash-preview',
        defaultEffort: '',
        efforts: [],
        models: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    },
    opencode: {
        label: 'OpenCode',
        binary: 'opencode',
        defaultModel: 'opencode/big-pickle',
        defaultEffort: '',
        efforts: ['minimal', 'low', 'high', 'max'],
        models: [
            'anthropic/claude-opus-4-6-thinking',
            'anthropic/claude-sonnet-4-6-thinking',
            'anthropic/claude-sonnet-4-6',
            'openai/gpt-5.4-xhigh',
            'openai/gpt-5.4-high',
            'openai/gpt-5.3-codex-xhigh',
            'openai/gpt-5.3-codex-high',
            'opencode/big-pickle',
            'opencode-go/glm-5',
            'opencode-go/glm-5.1',
            'opencode-go/kimi-k2.5',
            'opencode-go/kimi-k2.6',
            'opencode-go/mimo-v2-pro',
            'opencode-go/mimo-v2-omni',
            'opencode-go/minimax-m2.5',
            'opencode-go/minimax-m2.7',
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
        effortNote: '→ ~/.copilot/config.json',
        models: [
            'gpt-5.5',
            'claude-opus-4.7',
            'claude-sonnet-4.6',
            'claude-haiku-4.5',
            'gpt-5.4',
            'gpt-5.4-mini',
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
    const out: Record<string, any> = {};
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key as keyof typeof CLI_REGISTRY];
        out[key] = {
            model: entry.defaultModel,
            effort: entry.defaultEffort || '',
        };
    }
    return out;
}

export function buildModelChoicesByCli() {
    const out: Record<string, any> = {};
    for (const key of CLI_KEYS) out[key] = [...(CLI_REGISTRY[key as keyof typeof CLI_REGISTRY].models || [])];
    return out;
}
