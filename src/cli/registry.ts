// ─── CLI Registry (single source of truth) ──────────

import { getDefaultClaudeChoices, getDefaultClaudeModel } from './claude-models.js';
import { CURSOR_EFFORT_CHOICES, CURSOR_REGISTRY_MODELS } from '../agent/cursor-runtime.js';
import type { CliEngine } from '../types/cli-engine.js';

export const CLI_REGISTRY = {
    agy: {
        label: 'Antigravity',
        binary: 'agy',
        experimental: true,
        defaultModel: 'Gemini 3.5 Flash (Medium)',
        defaultEffort: '',
        efforts: [],
        models: [
            'Gemini 3.5 Flash (Medium)',
            'Gemini 3.5 Flash (High)',
            'Gemini 3.5 Flash (Low)',
            'Gemini 3.1 Pro (Low)',
            'Gemini 3.1 Pro (High)',
            'Claude Sonnet 4.6 (Thinking)',
            'Claude Opus 4.6 (Thinking)',
            'GPT-OSS 120B (Medium)',
        ],
    },
    pi: {
        label: 'Pi',
        binary: 'pi',
        experimental: true,
        defaultProvider: 'progrok',
        defaultModel: 'grok-composer-2.5-fast',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortNote: 'Pi thinking level via RPC set_thinking_level',
        models: ['grok-composer-2.5-fast', 'grok-4.3'],
    },
    'ai-e': {
        label: 'AI-E',
        binary: 'ai-e',
        defaultProvider: 'claude',
        providers: ['claude', 'codex', 'gemini', 'grok', 'copilot', 'kiro'],
        defaultModel: getDefaultClaudeModel(),
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        models: [
            ...getDefaultClaudeChoices(),
            'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
            'gemini-3-flash-preview', 'gemini-2.5-pro',
            'grok-build', 'grok-composer-2.5-fast',
            'gpt-5-mini',
            'claude-sonnet-4.6',
        ],
        modelsByProvider: {
            claude: getDefaultClaudeChoices(),
            codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
            gemini: ['gemini-3-flash-preview', 'gemini-2.5-pro'],
            grok: ['grok-build', 'grok-composer-2.5-fast'],
            copilot: ['gpt-5-mini', 'claude-sonnet-4.6', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'],
            kiro: [
                'auto',
                'claude-fable-5',
                'claude-opus-4.8',
                'claude-opus-4.7',
                'claude-opus-4.6',
                'claude-sonnet-4.6',
                'claude-opus-4.5',
                'claude-sonnet-4.5',
                'claude-sonnet-4',
                'claude-haiku-4.5',
                'deepseek-3.2',
                'minimax-m2.5',
                'minimax-m2.1',
                'glm-5',
                'qwen3-coder-next',
            ],
        },
        effortsByProvider: {
            claude: ['low', 'medium', 'high', 'xhigh', 'max'],
            codex: ['low', 'medium', 'high', 'xhigh'],
            gemini: [],
            grok: [],
            copilot: ['low', 'medium', 'high'],
            kiro: [],
        },
    },
    claude: {
        label: 'Claude',
        binary: 'claude',
        defaultModel: getDefaultClaudeModel(),
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        models: getDefaultClaudeChoices(),
    },
    'claude-e': {
        label: 'Claude E',
        binary: 'claude-e',
        experimental: true,
        defaultModel: getDefaultClaudeModel(),
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        models: getDefaultClaudeChoices(),
    },
    codex: {
        label: 'Codex',
        binary: 'codex',
        defaultModel: 'gpt-5.5',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    },
    'codex-app': {
        label: 'Codex App',
        binary: 'codex',
        defaultModel: 'gpt-5.5',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    },
    cursor: {
        label: 'Cursor',
        binary: 'cursor-agent',
        experimental: true,
        defaultModel: 'composer-2.5',
        defaultEffort: 'medium',
        efforts: [...CURSOR_EFFORT_CHOICES],
        effortNote: 'Cursor effort resolves to model IDs; cli-jaw never passes --effort',
        models: [...CURSOR_REGISTRY_MODELS],
    },
    gemini: {
        label: 'Gemini',
        binary: 'gemini',
        defaultModel: 'gemini-3-flash-preview',
        defaultEffort: '',
        efforts: [],
        models: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    },
    grok: {
        label: 'Grok',
        binary: 'grok',
        defaultModel: 'grok-build',
        defaultEffort: '',
        efforts: [],
        effortNote: 'unsupported by grok-build/composer; do not pass --effort',
        models: ['grok-build', 'grok-composer-2.5-fast'],
    },
    jwc: {
        label: 'JWC',
        // In-process / resident ACP engine — no external binary spawned in the
        // main-managed path (see JawRuntime). `binary` is used only by the dev
        // fallback that shells out to `jwc --mode acp`.
        binary: 'jwc',
        experimental: true,
        defaultProvider: 'anthropic',
        providers: ['anthropic'],
        defaultModel: 'claude-fable-5',
        defaultEffort: 'high',
        efforts: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
        models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
        modelsByProvider: {
            anthropic: [
                'claude-fable-5',
                'claude-opus-4-8',
                'claude-opus-4-7',
                'claude-opus-4-6',
                'claude-sonnet-4-6',
                'claude-haiku-4-5',
            ],
        },
        effortsByProvider: {
            anthropic: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
        },
    },
    'kiro-code': {
        label: 'Kiro',
        binary: 'kiro-cli',
        defaultModel: 'auto',
        defaultEffort: '',
        efforts: [],
        effortNote: 'Kiro CLI has no separate effort flag',
        models: [
            'auto',
            'claude-fable-5',
            'claude-opus-4.8',
            'claude-opus-4.7',
            'claude-opus-4.6',
            'claude-sonnet-4.6',
            'claude-opus-4.5',
            'claude-sonnet-4.5',
            'claude-sonnet-4',
            'claude-haiku-4.5',
            'deepseek-3.2',
            'minimax-m2.5',
            'minimax-m2.1',
            'glm-5',
            'qwen3-coder-next',
        ],
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
            'claude-fable-5',
            'claude-opus-4.8',
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
const envDefaultCli = process.env['CLI_JAW_DEFAULT_CLI'];
export const DEFAULT_CLI: CliEngine = (envDefaultCli && CLI_KEYS.includes(envDefaultCli as CliEngine))
    ? envDefaultCli as CliEngine
    : CLI_KEYS.includes('claude') ? 'claude' : (CLI_KEYS[0] ?? 'claude');

export function buildDefaultPerCli() {
    const out: Record<string, { model: string; effort: string }> = {};
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key as keyof typeof CLI_REGISTRY];
        out[key] = {
            model: entry.defaultModel,
            effort: entry.defaultEffort || '',
            ...('defaultProvider' in entry ? { provider: entry.defaultProvider } : {}),
        };
    }
    return out;
}

export function buildModelChoicesByCli() {
    const out: Record<string, string[]> = {};
    for (const key of CLI_KEYS) out[key] = [...(CLI_REGISTRY[key as keyof typeof CLI_REGISTRY].models || [])];
    return out;
}
