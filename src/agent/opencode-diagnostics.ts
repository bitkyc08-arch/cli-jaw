import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { join } from 'path';

const DEFAULT_RAW_EVENT_LIMIT = 100;
const PERMISSION_KEYS = [
    '*',
    'external_directory',
    'bash',
    'edit',
    'read',
    'webfetch',
    'websearch',
] as const;

export type OpencodePermissionSummary = Record<typeof PERMISSION_KEYS[number], unknown>;

export type OpencodeSpawnAudit = {
    binary: string;
    version: string;
    cwd: string;
    argsPreview: string[];
    pathHead: string[];
    permission: Partial<OpencodePermissionSummary>;
};

export type OpencodeRuntimeSnapshot = {
    lastEventType?: string;
    lastEventAt?: number;
    finishReason?: string;
    pendingPreToolTextChars: number;
    pendingPostToolTextChars: number;
    pendingToolRefs: number;
    rawEventCount: number;
};

function splitPathHead(pathValue: string | undefined, limit = 5): string[] {
    return String(pathValue || '').split(':').filter(Boolean).slice(0, limit);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function redactOpencodeArgs(args: string[]): string[] {
    if (!args.length) return [];
    const next = [...args];
    const lastIdx = next.length - 1;
    const last = next[lastIdx] || '';
    if (last && !last.startsWith('-')) {
        next[lastIdx] = '<prompt:redacted>';
    }
    return next;
}

export function readOpencodePermissionSummary(
    configPath = join(os.homedir(), '.config', 'opencode', 'opencode.json'),
): Partial<OpencodePermissionSummary> {
    try {
        if (!fs.existsSync(configPath)) return {};
        const raw = fs.readFileSync(configPath, 'utf8').trim();
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!isPlainObject(parsed) || !isPlainObject(parsed.permission)) return {};
        const summary: Partial<OpencodePermissionSummary> = {};
        for (const key of PERMISSION_KEYS) {
            if (Object.prototype.hasOwnProperty.call(parsed.permission, key)) {
                summary[key] = parsed.permission[key];
            }
        }
        return summary;
    } catch {
        return {};
    }
}

export function resolveOpencodeBinary(
    env: NodeJS.ProcessEnv = process.env,
    fallback = 'opencode',
): string {
    try {
        const result = spawnSync('/usr/bin/which', ['opencode'], {
            env,
            encoding: 'utf8',
        });
        const resolved = String(result.stdout || '').trim().split(/\r?\n/)[0];
        return resolved || fallback;
    } catch {
        return fallback;
    }
}

export function readOpencodeVersion(
    binary = 'opencode',
    env: NodeJS.ProcessEnv = process.env,
): string {
    try {
        const result = spawnSync(binary, ['--version'], {
            env,
            encoding: 'utf8',
            timeout: 5000,
        });
        return String(result.stdout || result.stderr || '').trim();
    } catch {
        return '';
    }
}

export function buildOpencodeSpawnAudit(input: {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    binary?: string;
    configPath?: string;
}): OpencodeSpawnAudit {
    const binary = input.binary || resolveOpencodeBinary(input.env);
    return {
        binary,
        version: readOpencodeVersion(binary, input.env),
        cwd: input.cwd,
        argsPreview: redactOpencodeArgs(input.args),
        pathHead: splitPathHead(input.env.PATH),
        permission: readOpencodePermissionSummary(input.configPath),
    };
}

export function pushOpencodeRawEvent(
    buffer: string[] | undefined,
    line: string,
    limit = DEFAULT_RAW_EVENT_LIMIT,
): string[] {
    const next = [...(buffer || []), line];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

export function buildOpencodeRuntimeSnapshot(ctx: {
    finishReason?: string;
    opencodePreToolText?: string;
    opencodePostToolText?: string;
    opencodePendingToolRefs?: string[];
    opencodeRawEvents?: string[];
    opencodeLastEventType?: string;
    opencodeLastEventAt?: number;
}): OpencodeRuntimeSnapshot {
    return {
        lastEventType: ctx.opencodeLastEventType,
        lastEventAt: ctx.opencodeLastEventAt,
        finishReason: ctx.finishReason,
        pendingPreToolTextChars: (ctx.opencodePreToolText || '').length,
        pendingPostToolTextChars: (ctx.opencodePostToolText || '').length,
        pendingToolRefs: ctx.opencodePendingToolRefs?.length || 0,
        rawEventCount: ctx.opencodeRawEvents?.length || 0,
    };
}
