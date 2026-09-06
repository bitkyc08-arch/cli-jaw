import { isAbsolute } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

export interface PreparedClaudeOptions {
    cwd: string;
    binary: string;
    env: NodeJS.ProcessEnv;
    model: string;
    systemPrompt: string;
    resumeSessionId?: string;
    permissions: 'auto' | 'safe';
    effort?: Options['effort'];
    fastMode: boolean;
}

const PREPARED_KEYS = new Set([
    'cwd', 'binary', 'env', 'model', 'systemPrompt', 'resumeSessionId', 'permissions', 'effort', 'fastMode',
]);
const EFFORTS: ReadonlySet<Options['effort']> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function validString(value: unknown, allowEmpty = false): value is string {
    return typeof value === 'string' && !value.includes('\0')
        && (allowEmpty && value === '' || value.trim().length > 0);
}

function snapshotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid Claude SDK env');
    const entries = Object.entries(env);
    for (const [key, value] of entries) {
        if (!key || /[=\0]/.test(key)
            || value !== undefined && (typeof value !== 'string' || value.includes('\0'))) {
            throw new Error('Invalid Claude SDK env');
        }
    }
    return Object.fromEntries(entries);
}

function validatePrepared(input: PreparedClaudeOptions): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !PREPARED_KEYS.has(key))) {
        throw new Error('Invalid Claude SDK options');
    }
    if (!validString(input.cwd) || !isAbsolute(input.cwd)) throw new Error('Invalid Claude SDK cwd');
    // Detected absolute paths and PATH-resolved command names are both spawnable forms.
    if (!validString(input.binary)) throw new Error('Invalid Claude SDK binary');
    if (input.permissions !== 'auto' && input.permissions !== 'safe') {
        throw new Error('Invalid Claude SDK permissions');
    }
    if (input.effort !== undefined && !EFFORTS.has(input.effort)) throw new Error('Invalid Claude SDK effort');
    if (typeof input.fastMode !== 'boolean') throw new Error('Invalid Claude SDK fastMode');
    if (!validString(input.model, true)) throw new Error('Invalid Claude SDK model');
    // Prompt bytes are preserved; whitespace-only prompts are also valid append content.
    if (typeof input.systemPrompt !== 'string' || input.systemPrompt.includes('\0')) {
        throw new Error('Invalid Claude SDK systemPrompt');
    }
    if (input.resumeSessionId !== undefined && !validString(input.resumeSessionId)) {
        throw new Error('Invalid Claude SDK resumeSessionId');
    }
}

/** Translate a prepared snapshot only: no configuration, credential or process reads. */
export function buildClaudeSdkOptions(input: PreparedClaudeOptions): Options {
    validatePrepared(input);
    const env = snapshotEnv(input.env);
    return {
        cwd: input.cwd,
        pathToClaudeCodeExecutable: input.binary,
        env,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPrompt },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        maxTurns: 500,
        permissionMode: input.permissions === 'auto' ? 'bypassPermissions' : 'default',
        ...(input.permissions === 'auto' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(input.model && input.model !== 'default' ? { model: input.model } : {}),
        // Match Claude print/resume args: medium leaves the provider's configured effort intact.
        ...(input.effort !== undefined && input.effort !== 'medium' ? { effort: input.effort } : {}),
        ...(input.fastMode ? { settings: { fastMode: true } } : {}),
        ...(input.resumeSessionId !== undefined ? { resume: input.resumeSessionId } : {}),
    };
}
