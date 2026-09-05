import type { RuntimeEventBody, RuntimePhase } from '../../shared/runtime-contract.js';

export type PrintToolInput = { icon: string; label: string; toolType: string; detail?: string;
    stepRef?: string; traceSeq?: number; status?: string };
export interface PrintActivityProjection {
    nextMessage(): void;
    message(text: string, operation: 'append' | 'replace', phase?: RuntimePhase): void;
    reasoning(text: string, operation: 'append' | 'replace'): void;
    tool(entry: PrintToolInput): void;
    finish(end: Extract<RuntimeEventBody, { kind: 'turn-end' }>): void;
}

/** Observes accepted print content, never selects an answer or retains output buffers. */
export function createPrintActivityProjection(emit: (body: RuntimeEventBody) => void): PrintActivityProjection {
    let message = 1, thought = 0, anonymous = 0;
    let closed = false, failed = false, currentThought: string | null = null;
    const send = (body: RuntimeEventBody): void => {
        if (closed || failed) return;
        try { emit(body); }
        catch { failed = true; console.warn('[activity:print] observer_failed'); }
    };
    return {
        nextMessage() { if (!closed) { message++; currentThought = null; } },
        message(text, operation, phase = 'unknown') {
            send({ kind: 'message', itemId: `print:message:${message}`, phase, text, operation });
        },
        reasoning(text, operation) {
            if (operation === 'replace' || currentThought === null) currentThought = `print:reasoning:${++thought}`;
            send({ kind: 'reasoning', itemId: currentThought, text, operation });
        },
        tool(entry) {
            const itemId = entry.stepRef ? `print:ref:${entry.stepRef}`
                : entry.traceSeq ? `print:trace:${entry.traceSeq}` : `print:anonymous:${++anonymous}`;
            if (entry.icon === '💬') {
                send({ kind: 'message', itemId, phase: 'unknown', text: entry.detail ?? entry.label, operation: 'replace' });
            } else if (entry.toolType === 'thinking' || entry.icon === '💭') {
                send({ kind: 'reasoning', itemId, text: entry.detail ?? entry.label, operation: 'replace' });
            } else {
                const status = entry.status === 'error' ? 'error' : entry.status === 'done' ? 'done'
                    : entry.status === 'stopped' ? 'stopped' : 'running';
                send({ kind: 'tool', itemId, name: entry.label, status,
                    ...(entry.detail === undefined ? {} : { detail: entry.detail }) });
            }
        },
        finish(end) { if (!closed) { send(end); closed = true; } },
    };
}
