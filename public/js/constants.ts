// ── Shared constants (frontend) ──
import { api } from './api.js';

export interface CliEntry {
    label: string;
    efforts: string[];
    models: string[];
    effortNote?: string;
}

export type CliRegistry = Record<string, CliEntry>;

const FALLBACK_CLI_REGISTRY: CliRegistry = {
    claude: {
        label: 'Claude',
        efforts: ['low', 'medium', 'high'],
        models: ['sonnet', 'opus', 'sonnet[1m]', 'opus[1m]', 'haiku'],
    },
    codex: {
        label: 'Codex',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    },
    gemini: {
        label: 'Gemini',
        efforts: [],
        models: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    },
    opencode: {
        label: 'OpenCode',
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
        efforts: ['low', 'medium', 'high'],
        effortNote: '-> ~/.copilot/config.json',
        models: [
            'claude-sonnet-4.6',
            'claude-opus-4.6',
            'claude-opus-4.6-fast',
            'claude-haiku-4.5',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex',
            'gpt-4.1',
            'gpt-5-mini',
            'gemini-3-pro-preview',
        ],
    },
};

type ModelMap = Record<string, string[]>;

function toModelMap(registry: CliRegistry): ModelMap {
    const out: ModelMap = {};
    for (const [key, value] of Object.entries(registry)) {
        out[key] = Array.isArray(value?.models) ? [...value.models] : [];
    }
    return out;
}

function normalizeRegistry(input: Record<string, unknown>): CliRegistry {
    const out: CliRegistry = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        const normalized: CliEntry = {
            label: (v.label as string) || key,
            efforts: Array.isArray(v.efforts) ? [...v.efforts] as string[] : [],
            models: Array.isArray(v.models) ? [...v.models] as string[] : [],
        };
        if (typeof v.effortNote === 'string' && v.effortNote.trim()) {
            normalized.effortNote = v.effortNote;
        }
        out[key] = normalized;
    }
    return out;
}

export let CLI_REGISTRY: CliRegistry = normalizeRegistry(FALLBACK_CLI_REGISTRY as unknown as Record<string, unknown>);
export let CLI_KEYS: string[] = Object.keys(CLI_REGISTRY);
export let MODEL_MAP: ModelMap = toModelMap(CLI_REGISTRY);

function applyRegistry(registry: Record<string, unknown>): boolean {
    const normalized = normalizeRegistry(registry);
    if (!Object.keys(normalized).length) return false;
    CLI_REGISTRY = normalized;
    CLI_KEYS = Object.keys(normalized);
    MODEL_MAP = toModelMap(normalized);
    return true;
}

export async function loadCliRegistry(): Promise<CliRegistry> {
    try {
        const data = await api<Record<string, unknown>>('/api/cli-registry');
        if (!data || !applyRegistry(data)) throw new Error('invalid registry');
    } catch (e) {
        console.warn('[cli-registry] fallback:', (e as Error).message);
        applyRegistry(FALLBACK_CLI_REGISTRY as unknown as Record<string, unknown>);
    }
    return CLI_REGISTRY;
}

export function getCliKeys(): string[] {
    return CLI_KEYS;
}

export function getCliMeta(cli: string): CliEntry | null {
    return CLI_REGISTRY[cli] || null;
}

export interface RolePreset {
    value: string;
    labelKey: string;
    label: string;
    prompt: string;
    skill: string | null;
}

export const ROLE_PRESETS: readonly RolePreset[] = [
    { value: 'frontend', labelKey: 'role.label.frontend', label: 'Frontend', prompt: 'Frontend employee — UI/UX, CSS, components', skill: 'dev-frontend' },
    { value: 'backend', labelKey: 'role.label.backend', label: 'Backend', prompt: 'Backend employee — API, DB, server logic', skill: 'dev-backend' },
    { value: 'research', labelKey: 'role.label.research', label: 'Research', prompt: 'Research employee — search, codebase exploration, uncertainty reduction, read-only reports', skill: 'research-worker' },
    { value: 'data', labelKey: 'role.label.data', label: 'Data', prompt: 'Data employee — data pipeline, analysis, ML', skill: 'dev-data' },
    { value: 'docs', labelKey: 'role.label.docs', label: 'Docs', prompt: 'Docs employee — documentation, README, API docs', skill: 'documentation' },
    { value: 'custom', labelKey: 'role.label.custom', label: 'Custom...', prompt: '', skill: null },
] as const;
