import type { CodeModelOptions } from './code-session-client';
import { normalizeCodeCommands, type CodeCommand } from './code-types';

export const FALLBACK_MODEL_OPTIONS: CodeModelOptions = {
    providers: [{
        id: 'anthropic',
        models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
        efforts: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
    }],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    degraded: true,
};

export const FALLBACK_CODE_COMMANDS = normalizeCodeCommands([
    { name: '/model', description: 'Choose provider, model, roles, thinking, profiles, and MRU state.', source: 'cli-jaw' },
    { name: '/provider', description: 'Review authenticated JWC providers.', source: 'cli-jaw' },
    { name: '/settings', description: 'Adjust Code mode session controls.', source: 'cli-jaw' },
]);

export function mergeCodeCommands(primary: CodeCommand[]): CodeCommand[] {
    const seen = new Set<string>();
    const merged: CodeCommand[] = [];
    for (const command of [...primary, ...FALLBACK_CODE_COMMANDS]) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        merged.push(command);
    }
    return merged;
}
