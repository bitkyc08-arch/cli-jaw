// ─── bgtask: presets ─────────────────────────────────
// Spec builders for common task shapes. web-ai preset rides the NATIVE
// in-process watcher (src/browser/web-ai/watcher.ts owns DOM polling); the
// bgtask probe only reads session status, so there is no double polling and
// no agbrowse PATH dependency.

import type { BgTaskSpec } from './types.js';

const WEB_AI_DEFAULT_DEADLINE_MS = 2 * 60 * 60 * 1000; // 2h — covers Pro/DeepThink long runs

export interface WebAiPresetInput {
    sessionId: string;
    /** Boss prompt template override. Placeholders: {{result}} {{taskId}} {{status}} */
    prompt?: string;
    deadlineAt?: string;
    stallAfterMs?: number;
}

export interface WebAiPresetResult {
    kind: 'web-ai';
    spec: BgTaskSpec;
    warnings: string[];
}

/** Build a session-probe spec for a native web-ai session. Throws when the
 * session does not exist; warns when no active watcher is advancing it
 * (the probe would then only complete if something external advances state,
 * e.g. notifyOnComplete watchers may also send a channel text — see plan). */
export async function webAiPreset(input: WebAiPresetInput): Promise<WebAiPresetResult> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new Error('web-ai preset requires sessionId');

    const session = await import('../browser/web-ai/session.js');
    const record = session.getSession(sessionId);
    if (!record) throw new Error(`web-ai session not found: ${sessionId}`);

    const warnings: string[] = [];
    const terminal = ['complete', 'timeout', 'error'].includes(String(record.status));
    if (!terminal) {
        const watcher = await import('../browser/web-ai/watcher.js');
        const hasWatcher = watcher.listActiveWebAiWatchers()
            .some((w) => w.sessionId === sessionId && w.status === 'running');
        if (!hasWatcher) {
            warnings.push(
                `no active native watcher for session ${sessionId} — the probe only observes; `
                + 'start one (web-ai watch / notifyOnComplete) or the session may never reach a terminal status',
            );
        }
    }

    const spec: BgTaskSpec = {
        completion: { type: 'session-status', sessionId },
        resultExtractor: { type: 'session-answer' },
        promptTemplate: input.prompt?.trim()
            || `[bgtask:{{taskId}}] web-ai session ${sessionId} finished ({{status}}). Result:\n{{result}}\n\nInterpret the result and deliver it to the user.`,
        deadlineAt: input.deadlineAt ?? new Date(Date.now() + WEB_AI_DEFAULT_DEADLINE_MS).toISOString(),
        ...(input.stallAfterMs && input.stallAfterMs > 0 ? { stallAfterMs: input.stallAfterMs } : {}),
    };
    return { kind: 'web-ai', spec, warnings };
}
