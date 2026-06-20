// ─── bgtask: types + constants ───────────────────────
// Background runtime hook — server-owned long-running tasks that re-invoke
// the boss agent on completion. Design: devlog/_plan/260611_bgtask_background_runtime/

import type { RuntimeOrigin, RemoteTarget } from '../messaging/types.js';

export type BgTaskStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'orphaned';

export type BgTaskCompletion =
    | { type: 'exit' }
    | { type: 'json-line'; match: Record<string, string> }
    | { type: 'line-pattern'; regex: string }
    | { type: 'session-status'; sessionId: string };

export type BgTaskResultExtractor =
    | { type: 'tail-lines'; n: number }
    | { type: 'matched-line' }
    | { type: 'command'; command: string[] }
    | { type: 'session-answer' };

/** Channel routing captured at registration (getCurrentMainMeta shape).
 * origin here is informational only — notifier always submits with origin 'bgtask'. */
export interface OriginMeta {
    origin?: RuntimeOrigin | string;
    target?: RemoteTarget;
    chatId?: string | number;
}

export interface BgTaskSpec {
    /** argv array, spawned without a shell. Required for child mode
     * (completion.type !== 'session-status'); absent for probe mode. */
    command?: string[];
    cwd?: string;
    /** Additive env only — never replaces process.env. */
    env?: Record<string, string>;
    completion: BgTaskCompletion;
    resultExtractor?: BgTaskResultExtractor;
    /** Boss prompt template. Placeholders: {{result}} {{taskId}} {{status}} */
    promptTemplate: string;
    /** MVP supports 'queue' only (submitMessage handles busy queueing). */
    policy?: 'queue';
    stallAfterMs?: number;
    maxResultChars?: number;
    /** Respawn once after stall/crash. Only safe for idempotent watchers. */
    respawn?: boolean;
    /** ISO timestamp — task is failed when exceeded. */
    deadlineAt?: string;
}

export interface BgTaskRow {
    id: string;
    kind: string;
    spec: BgTaskSpec;
    status: BgTaskStatus;
    pid: number | null;
    originMeta: OriginMeta;
    result: string | null;
    createdAt: string | null;
    startedAt: string | null;
    deadlineAt: string | null;
    completedAt: string | null;
    notifiedAt: string | null;
}

export const BGTASK_DEFAULT_STALL_MS = 10 * 60_000;
export const BGTASK_PROBE_INTERVAL_MS = 30_000;
export const BGTASK_DEFAULT_MAX_RESULT_CHARS = 32_000;
export const BGTASK_STDERR_RING_LINES = 100;

const COMPLETION_TYPES = new Set(['exit', 'json-line', 'line-pattern', 'session-status']);
const EXTRACTOR_TYPES = new Set(['tail-lines', 'matched-line', 'command', 'session-answer']);

export type SpecValidation = { ok: true; spec: BgTaskSpec } | { ok: false; error: string };

export function validateBgTaskSpec(input: unknown): SpecValidation {
    if (!input || typeof input !== 'object') return { ok: false, error: 'spec must be an object' };
    const spec = input as Record<string, unknown>;
    const completion = spec['completion'] as Record<string, unknown> | undefined;
    if (!completion || typeof completion !== 'object' || !COMPLETION_TYPES.has(String(completion['type']))) {
        return { ok: false, error: `completion.type must be one of: ${[...COMPLETION_TYPES].join(', ')}` };
    }
    const isProbe = completion['type'] === 'session-status';
    if (isProbe) {
        if (typeof completion['sessionId'] !== 'string' || !completion['sessionId'].trim()) {
            return { ok: false, error: 'session-status completion requires sessionId' };
        }
    } else {
        const command = spec['command'];
        if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === 'string')) {
            return { ok: false, error: 'child-mode spec requires command: string[] (argv, no shell)' };
        }
    }
    if (completion['type'] === 'json-line') {
        const match = completion['match'];
        if (!match || typeof match !== 'object' || Object.keys(match as object).length === 0) {
            return { ok: false, error: 'json-line completion requires non-empty match object' };
        }
    }
    if (completion['type'] === 'line-pattern') {
        try {
            // Validation only — the regex is recompiled at runtime in the runner.
            void new RegExp(String(completion['regex']));
        } catch {
            return { ok: false, error: 'line-pattern completion requires a valid regex' };
        }
    }
    if (typeof spec['promptTemplate'] !== 'string' || !spec['promptTemplate'].trim()) {
        return { ok: false, error: 'promptTemplate is required' };
    }
    const extractor = spec['resultExtractor'] as Record<string, unknown> | undefined;
    if (extractor !== undefined) {
        if (!extractor || typeof extractor !== 'object' || !EXTRACTOR_TYPES.has(String(extractor['type']))) {
            return { ok: false, error: `resultExtractor.type must be one of: ${[...EXTRACTOR_TYPES].join(', ')}` };
        }
        if (extractor['type'] === 'command') {
            const cmd = extractor['command'];
            if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === 'string')) {
                return { ok: false, error: 'command extractor requires command: string[]' };
            }
        }
        if (extractor['type'] === 'tail-lines' && !(Number(extractor['n']) > 0)) {
            return { ok: false, error: 'tail-lines extractor requires n > 0' };
        }
    }
    if (spec['deadlineAt'] !== undefined && !Number.isFinite(Date.parse(String(spec['deadlineAt'])))) {
        return { ok: false, error: 'deadlineAt must be an ISO timestamp' };
    }
    return { ok: true, spec: spec as unknown as BgTaskSpec };
}

/** Duplicate-detection key: sessionId for probe mode, argv JSON for child mode. */
export function dedupKeyForSpec(spec: BgTaskSpec): string {
    if (spec.completion.type === 'session-status') return `session:${spec.completion.sessionId}`;
    return `cmd:${JSON.stringify(spec.command ?? [])}`;
}
