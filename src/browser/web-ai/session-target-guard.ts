import { WebAiError } from './errors.js';
import { listSessions } from './session.js';
import type { WebAiVendor, WebAiSessionRecord } from './types.js';

const DEFAULT_VENDOR: WebAiVendor = 'chatgpt';
const IMPLICIT_SESSION_COMMANDS = new Set(['poll', 'stop']);

export interface SessionCandidate {
    sessionId: string;
    vendor: WebAiVendor | null;
    status: string | null;
    targetId: string | null;
    conversationUrl: string | null;
    deadlineAt: string | null;
}

export function normalizeWebAiVendor(value: unknown): WebAiVendor {
    const v = String(value || DEFAULT_VENDOR).toLowerCase();
    if (v === 'chatgpt' || v === 'gemini' || v === 'grok') return v;
    return DEFAULT_VENDOR;
}

export function sanitizeSessionCandidate(session: WebAiSessionRecord): SessionCandidate {
    return {
        sessionId: String(session.sessionId || ''),
        vendor: session.vendor || null,
        status: session.status || null,
        targetId: session.targetId || null,
        conversationUrl: session.conversationUrl || null,
        deadlineAt: null,
    };
}

export function activeProviderSessionCandidates(vendor: WebAiVendor): SessionCandidate[] {
    return listSessions({ vendor: normalizeWebAiVendor(vendor) })
        .filter((s) => s.status === 'sent' || s.status === 'streaming')
        .map(sanitizeSessionCandidate)
        .filter((c) => c.sessionId);
}

export function resolveImplicitSessionSelection(input: {
    command?: string;
    vendor?: string;
    session?: string | null;
    port?: string | number;
}): { action: 'explicit' | 'none' | 'auto-bind'; sessionId: string | null; candidates: SessionCandidate[] } {
    const command = String(input.command || '');
    if (input.session || !IMPLICIT_SESSION_COMMANDS.has(command)) {
        return { action: 'explicit', sessionId: input.session ? String(input.session) : null, candidates: [] };
    }
    const vendor = normalizeWebAiVendor(input.vendor);
    const candidates = activeProviderSessionCandidates(vendor);
    if (candidates.length === 0) return { action: 'none', sessionId: null, candidates };
    if (candidates.length === 1) {
        return { action: 'auto-bind', sessionId: candidates[0]!.sessionId, candidates };
    }
    throw ambiguousSessionTargetError({
        command,
        vendor,
        port: Number(input.port || 9222),
        candidates,
    });
}

export function ambiguousSessionTargetError(input: {
    command: string;
    vendor: string;
    port: number;
    candidates: SessionCandidate[];
}): WebAiError {
    const summary = input.candidates
        .map((c) => `${c.sessionId}${c.targetId ? ` target=${c.targetId}` : ''}`)
        .join(', ');
    return new WebAiError({
        errorCode: 'session.target-ambiguous',
        stage: 'target-resolution',
        vendor: input.vendor,
        retryHint: 'pass-session',
        message: `multiple active ${input.vendor} web-ai sessions on CDP port ${input.port}; pass --session <id>. candidates: ${summary}`,
        mutationAllowed: false,
        evidence: {
            command: input.command,
            vendor: input.vendor,
            port: input.port,
            candidates: input.candidates,
        },
    });
}

export function sessionPollRecoveryCommand(vendor: string, sessionId: string): string {
    return `cli-jaw browser web-ai poll --vendor ${normalizeWebAiVendor(vendor)} --session ${sessionId} --navigate --json`;
}

export function buildTargetMismatchResult(input: {
    vendor: string;
    session: WebAiSessionRecord;
    actualTargetId: string;
    port?: number;
    url?: string;
    baseline?: unknown;
}): Record<string, unknown> {
    const expectedTargetId = input.session?.targetId || null;
    const actualTargetId = input.actualTargetId || null;
    const port = Number(input.port || 9222);
    const sessionId = String(input.session?.sessionId || '');
    const recovery = sessionPollRecoveryCommand(input.vendor, sessionId);
    return {
        ok: false,
        vendor: input.vendor,
        status: 'target-mismatch',
        url: input.url || input.session?.conversationUrl || input.session?.url || '',
        sessionId,
        answerText: '',
        baseline: input.baseline,
        usedFallbacks: [],
        expectedTargetId,
        actualTargetId,
        port,
        targetMismatch: { expectedTargetId, actualTargetId, port, sessionId, vendor: input.vendor, recovery },
        recovery,
        warnings: [`poll target changed: ${expectedTargetId || 'unknown'} -> ${actualTargetId || 'unknown'}`],
        error: 'target changed during poll',
    };
}
