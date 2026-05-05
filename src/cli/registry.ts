// ─── CLI Registry (single source of truth) ──────────

import { getDefaultClaudeChoices, getDefaultClaudeModel } from './claude-models.js';
import type { CliEngine } from '../types/cli-engine.js';

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
        defaultModel: 'opencode-go/kimi-k2.6',
        defaultEffort: '',
        efforts: ['minimal', 'low', 'high', 'max'],
        models: [
            'opencode-go/glm-5.1',
            'opencode-go/kimi-k2.6',
            'opencode-go/mimo-v2.5-pro',
            'opencode-go/mimo-v2.5',
            'opencode-go/minimax-m2.7',
            'opencode-go/qwen3.6-plus',
            'opencode-go/deepseek-v4-pro',
            'opencode-go/deepseek-v4-flash',
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

export const CLI_KEYS = Object.keys(CLI_REGISTRY) as CliEngine[];
export const DEFAULT_CLI: CliEngine = CLI_KEYS.includes('claude') ? 'claude' : (CLI_KEYS[0] ?? 'claude');

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
