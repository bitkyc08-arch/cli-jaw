// CLI registry helpers ported from public/js/constants.ts (read-only source,
// UI freeze policy — logic is ported, not imported, to avoid DOM side effects).
import type { SettingsClient } from '../settings/types';

export interface CliEntry {
    label: string;
    efforts: string[];
    models: string[];
    defaultProvider?: string;
    providers?: string[];
    modelsByProvider?: Record<string, string[]>;
    effortsByProvider?: Record<string, string[]>;
    effortNote?: string;
    modelNote?: string;
}

export type CliRegistry = Record<string, CliEntry>;

export const PRIMARY_CLIS: readonly string[] = ['pi', 'claude', 'claude-e', 'agy', 'codex', 'cursor', 'kiro-code', 'gemini'];

export interface RolePreset {
    value: string;
    label: string;
    prompt: string;
}

export const ROLE_PRESETS: readonly RolePreset[] = [
    { value: 'frontend', label: 'Frontend', prompt: 'Frontend employee — UI/UX, CSS, components' },
    { value: 'backend', label: 'Backend', prompt: 'Backend employee — API, DB, server logic' },
    { value: 'data', label: 'Data', prompt: 'Data employee — data pipeline, analysis, ML' },
    { value: 'docs', label: 'Docs', prompt: 'Docs employee — documentation, README, API docs' },
    { value: 'security', label: 'Security', prompt: 'Security reviewer — auth, secrets, injection, destructive-command, sandbox, and data exposure risks' },
    { value: 'testing', label: 'Testing', prompt: 'Testing reviewer — unit, integration, regression, smoke, and edge-case coverage' },
    { value: 'custom', label: 'Custom...', prompt: '' },
] as const;

export function normalizeRegistry(input: Record<string, unknown>): CliRegistry {
    const out: CliRegistry = {};
    for (const [key, raw] of Object.entries(input || {})) {
        if (!raw || typeof raw !== 'object') continue;
        const v = raw as Record<string, unknown>;
        const entry: CliEntry = {
            label: typeof v['label'] === 'string' ? v['label'] : key,
            efforts: Array.isArray(v['efforts']) ? (v['efforts'] as string[]).filter((e) => typeof e === 'string') : [],
            models: Array.isArray(v['models']) ? (v['models'] as string[]).filter((m) => typeof m === 'string') : [],
        };
        if (typeof v['defaultProvider'] === 'string') entry.defaultProvider = v['defaultProvider'];
        if (Array.isArray(v['providers'])) entry.providers = (v['providers'] as string[]).filter((p) => typeof p === 'string');
        if (v['modelsByProvider'] && typeof v['modelsByProvider'] === 'object') {
            entry.modelsByProvider = Object.fromEntries(
                Object.entries(v['modelsByProvider'] as Record<string, unknown>)
                    .filter((e): e is [string, string[]] => Array.isArray(e[1]))
                    .map(([p, models]) => [p, [...models]]),
            );
        }
        if (v['effortsByProvider'] && typeof v['effortsByProvider'] === 'object') {
            entry.effortsByProvider = Object.fromEntries(
                Object.entries(v['effortsByProvider'] as Record<string, unknown>)
                    .filter((e): e is [string, string[]] => Array.isArray(e[1]))
                    .map(([p, efforts]) => [p, [...efforts]]),
            );
        }
        if (typeof v['effortNote'] === 'string') entry.effortNote = v['effortNote'];
        if (typeof v['modelNote'] === 'string') entry.modelNote = v['modelNote'];
        out[key] = entry;
    }
    return out;
}

export function toModelMap(registry: CliRegistry): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, entry] of Object.entries(registry)) out[key] = entry.models;
    return out;
}

export async function fetchCliRegistry(client: SettingsClient): Promise<CliRegistry> {
    const data = await client.get<Record<string, unknown>>('/api/cli-registry');
    const normalized = normalizeRegistry(data);
    if (!Object.keys(normalized).length) throw new Error('invalid cli registry');
    return normalized;
}
