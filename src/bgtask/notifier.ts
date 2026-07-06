// ─── bgtask: notifier (completion → boss re-invocation) ──
// Turns a terminal task row into a boss prompt and submits it through the
// standard gateway (submitMessage) — idle boss spawns immediately, busy boss
// gets a durable queued_messages entry. Origin is ALWAYS 'bgtask'; stored
// originMeta only contributes target/chatId routing (audit round-2 ruling).

import { execFile } from 'node:child_process';
import { getTask, markNotified } from './registry.js';
import type { BgTaskCapture } from './runner.js';
import { BGTASK_DEFAULT_MAX_RESULT_CHARS, type BgTaskRow } from './types.js';
import { submitMessage } from '../orchestrator/gateway.js';
import type { RuntimeOrigin, RemoteTarget } from '../messaging/types.js';
import { log } from '../core/logger.js';

const COMMAND_EXTRACTOR_TIMEOUT_MS = 30_000;

export interface NotifierDeps {
    submit: typeof submitMessage;
    getWebAiAnswer: (sessionId: string) => Promise<string | null>;
}

const defaultDeps: NotifierDeps = {
    submit: submitMessage,
    async getWebAiAnswer(sessionId: string): Promise<string | null> {
        const session = await import('../browser/web-ai/session.js');
        const record = session.getSession(sessionId);
        if (!record) return null;
        const answer = (record as { answerText?: unknown }).answerText;
        return typeof answer === 'string' ? answer : null;
    },
};

/** Deliver the completion notification for a terminal task. Idempotent:
 * skips non-terminal, already-notified, or missing tasks. Returns true when
 * the notification was submitted (or absorbed as a gateway duplicate). */
export async function notifyTask(taskId: string, deps: Partial<NotifierDeps> = {}): Promise<boolean> {
    const d: NotifierDeps = { ...defaultDeps, ...deps };
    const row = getTask(taskId);
    if (!row) return false;
    if (row.status !== 'complete' && row.status !== 'failed') return false;
    if (row.notifiedAt) return false;

    let result: string;
    try {
        result = await extractResult(row, d);
    } catch (err) {
        result = `[result extraction failed: ${(err as Error).message}]`;
    }
    const maxChars = row.spec.maxResultChars ?? BGTASK_DEFAULT_MAX_RESULT_CHARS;
    if (result.length > maxChars) {
        result = `${result.slice(0, maxChars)}\n…[truncated ${result.length - maxChars} chars]`;
    }

    const prompt = renderPromptTemplate(row, result);
    const meta = row.originMeta;
    const res = d.submit(prompt, {
        origin: 'bgtask' as RuntimeOrigin,
        ...(meta.target ? { target: meta.target as RemoteTarget } : {}),
        ...(meta.chatId !== undefined ? { chatId: meta.chatId } : {}),
    });
    if (res.action === 'rejected' && res.reason !== 'duplicate') {
        log.error(`[bgtask:${taskId}] notify rejected: ${res.reason}`);
        return false;
    }
    markNotified(taskId);
    return true;
}

export function renderPromptTemplate(row: BgTaskRow, result: string): string {
    return row.spec.promptTemplate
        .replaceAll('{{taskId}}', row.id)
        .replaceAll('{{status}}', row.status)
        .replaceAll('{{result}}', result);
}

function parseCapture(row: BgTaskRow): BgTaskCapture {
    try {
        const parsed = JSON.parse(row.result ?? '{}') as Partial<BgTaskCapture>;
        return {
            stdoutTail: Array.isArray(parsed.stdoutTail) ? parsed.stdoutTail : [],
            stderrTail: Array.isArray(parsed.stderrTail) ? parsed.stderrTail : [],
            ...(parsed.matchedLine !== undefined ? { matchedLine: String(parsed.matchedLine) } : {}),
            ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
            ...(parsed.reason !== undefined ? { reason: String(parsed.reason) } : {}),
            ...(parsed.sessionStatus !== undefined ? { sessionStatus: String(parsed.sessionStatus) } : {}),
        };
    } catch {
        return { stdoutTail: [], stderrTail: [], reason: row.result ?? undefined } as BgTaskCapture;
    }
}

async function extractResult(row: BgTaskRow, deps: NotifierDeps): Promise<string> {
    const capture = parseCapture(row);
    const extractor = row.spec.resultExtractor;
    const failureContext = row.status === 'failed' ? buildFailureContext(capture) : '';

    let extracted: string;
    if (!extractor) {
        extracted = capture.matchedLine ?? capture.stdoutTail.slice(-20).join('\n');
    } else if (extractor.type === 'matched-line') {
        extracted = capture.matchedLine ?? '';
    } else if (extractor.type === 'tail-lines') {
        extracted = capture.stdoutTail.slice(-extractor.n).join('\n');
    } else if (extractor.type === 'command') {
        extracted = await runExtractorCommand(extractor.command);
    } else {
        // session-answer
        const sessionId = row.spec.completion.type === 'session-status'
            ? row.spec.completion.sessionId
            : null;
        const answer = sessionId ? await deps.getWebAiAnswer(sessionId) : null;
        extracted = answer ?? `[no answer recorded; session status: ${capture.sessionStatus ?? 'unknown'}]`;
    }
    return failureContext ? `${failureContext}\n${extracted}`.trim() : extracted;
}

function buildFailureContext(capture: BgTaskCapture): string {
    const lines = [`FAILED: ${capture.reason ?? `exit code ${capture.exitCode ?? 'unknown'}`}`];
    const stderr = capture.stderrTail.slice(-10);
    if (stderr.length > 0) lines.push('stderr (tail):', ...stderr);
    return lines.join('\n');
}

function runExtractorCommand(command: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        if (command.length === 0) {
            reject(new Error('empty extractor command'));
            return;
        }
        execFile(command[0]!, command.slice(1), {
            timeout: COMMAND_EXTRACTOR_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
        }, (err, stdout) => {
            if (err) {
                reject(new Error(`extractor command failed: ${err.message}`));
                return;
            }
            resolve(String(stdout).trim());
        });
    });
}
