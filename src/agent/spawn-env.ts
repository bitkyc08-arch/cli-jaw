import fs from 'fs';
import os from 'os';
import { dirname, join } from 'path';

const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';
const OPENCODE_ALLOW_PERMISSIONS = [
    '*',
    'bash',
    'codesearch',
    'doom_loop',
    'edit',
    'external_directory',
    'glob',
    'grep',
    'list',
    'lsp',
    'question',
    'read',
    'skill',
    'task',
    'todoread',
    'todowrite',
    'webfetch',
    'websearch',
] as const;
const GEMINI_TRUST_WORKSPACE_ENV = 'GEMINI_CLI_TRUST_WORKSPACE';

function prependPathDir(
    extraEnv: Record<string, string>,
    inheritedEnv: NodeJS.ProcessEnv,
    dir: string,
): Record<string, string> {
    const currentPath = extraEnv.PATH ?? inheritedEnv.PATH ?? '';
    const parts = currentPath.split(':').filter(Boolean).filter(part => part !== dir);
    return {
        ...extraEnv,
        PATH: [dir, ...parts].join(':'),
    };
}

export function getOpencodePreferredBinDir(): string {
    return join(os.homedir(), '.bun', 'bin');
}

export function applyCliEnvDefaults(
    cli: string,
    extraEnv: Record<string, string> = {},
    inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    if (cli === 'gemini') {
        if (extraEnv[GEMINI_TRUST_WORKSPACE_ENV] !== undefined) return extraEnv;
        if (inheritedEnv[GEMINI_TRUST_WORKSPACE_ENV] !== undefined) return extraEnv;
        return {
            ...extraEnv,
            [GEMINI_TRUST_WORKSPACE_ENV]: 'true',
        };
    }

    if (cli !== 'opencode') return extraEnv;
    const withPath = prependPathDir(extraEnv, inheritedEnv, getOpencodePreferredBinDir());
    if (withPath.OPENCODE_ENABLE_EXA !== undefined) return withPath;
    if (inheritedEnv.OPENCODE_ENABLE_EXA !== undefined) return withPath;
    return {
        ...withPath,
        OPENCODE_ENABLE_EXA: 'true',
    };
}

function isTruthyEnv(value: string | undefined): boolean {
    if (!value) return false;
    return value === '1' || value.toLowerCase() === 'true';
}

export function buildSessionResumeKey(
    cli: string,
    env: Record<string, string | undefined>,
): string | null {
    if (cli !== 'opencode') return null;
    return `exa=${isTruthyEnv(env.OPENCODE_ENABLE_EXA) ? '1' : '0'}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function withOpencodeAlwaysAllowPermissions(config: unknown): Record<string, unknown> {
    const next = isPlainObject(config) ? { ...config } : {};
    if (typeof next.$schema !== 'string') next.$schema = OPENCODE_CONFIG_SCHEMA;

    const permission = isPlainObject(next.permission) ? { ...next.permission } : {};
    for (const key of OPENCODE_ALLOW_PERMISSIONS) {
        permission[key] = 'allow';
    }
    next.permission = permission;
    return next;
}

export function ensureOpencodeAlwaysAllowPermissions(
    configPath = join(os.homedir(), '.config', 'opencode', 'opencode.json'),
): void {
    try {
        let current: unknown = {};
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8').trim();
            current = raw ? JSON.parse(raw) : {};
        }

        const next = withOpencodeAlwaysAllowPermissions(current);
        const serialized = `${JSON.stringify(next, null, 2)}\n`;
        const currentSerialized = fs.existsSync(configPath)
            ? fs.readFileSync(configPath, 'utf8')
            : '';
        if (currentSerialized === serialized) return;

        fs.mkdirSync(dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, serialized);
    } catch (error) {
        console.warn('[jaw:opencode] permission sync failed:', (error as Error).message);
    }
}
