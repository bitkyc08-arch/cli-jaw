import { createHash, randomUUID } from 'node:crypto';
import type {
    CommittedTurnBaseline,
    QuestionEnvelope,
    WebAiSessionRecord,
    WebAiSessionStatus,
    WebAiVendor,
} from './types.js';

const baselines = new Map<string, CommittedTurnBaseline>();
const sessions = new Map<string, WebAiSessionRecord>();
const sessionsByTarget = new Map<string, string>();

export class WrongTargetError extends Error {
    readonly stage = 'session-reattach' as const;
    readonly expectedTargetId: string;
    readonly actualTargetId: string;
    constructor(expected: string, actual: string) {
        super(`active target ${actual} does not match session target ${expected}; fail closed`);
        this.expectedTargetId = expected;
        this.actualTargetId = actual;
    }
}

export function hashPrompt(envelope: QuestionEnvelope): string {
    const payload = {
        vendor: envelope.vendor,
        system: envelope.system || '',
        prompt: envelope.prompt || '',
        project: envelope.project || '',
        goal: envelope.goal || '',
        context: envelope.context || '',
        question: envelope.question || '',
        output: envelope.output || '',
        constraints: envelope.constraints || '',
        attachmentPolicy: envelope.attachmentPolicy,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function makeBaselineKey(vendor: WebAiVendor, targetId: string): string {
    return `${vendor}:${targetId || 'unverified-target'}`;
}

export function saveBaseline(input: {
    vendor: WebAiVendor;
    targetId: string;
    url: string;
    envelope: QuestionEnvelope;
    assistantCount: number;
    textHash?: string;
}): CommittedTurnBaseline {
    const baseline: CommittedTurnBaseline = {
        vendor: input.vendor,
        targetId: input.targetId,
        url: input.url,
        promptHash: hashPrompt(input.envelope),
        assistantCount: input.assistantCount,
        capturedAt: new Date().toISOString(),
        ...(input.textHash ? { textHash: input.textHash } : {}),
    };
    baselines.set(makeBaselineKey(input.vendor, input.targetId), baseline);
    return baseline;
}

export function getBaseline(vendor: WebAiVendor, targetId: string): CommittedTurnBaseline | null {
    return baselines.get(makeBaselineKey(vendor, targetId)) || null;
}

export function clearBaseline(vendor: WebAiVendor, targetId: string): void {
    baselines.delete(makeBaselineKey(vendor, targetId));
}

export interface CreateSessionInput {
    vendor: WebAiVendor;
    targetId: string;
    url: string;
    conversationUrl?: string;
    envelope: QuestionEnvelope;
    assistantCount: number;
    committedTurnCount?: number;
    timeoutMs: number;
}

export function createSession(input: CreateSessionInput): WebAiSessionRecord {
    const now = new Date().toISOString();
    const record: WebAiSessionRecord = {
        vendor: input.vendor,
        sessionId: randomUUID(),
        targetId: input.targetId,
        url: input.url,
        ...(input.conversationUrl ? { conversationUrl: input.conversationUrl } : {}),
        promptHash: hashPrompt(input.envelope),
        assistantCount: input.assistantCount,
        ...(input.committedTurnCount !== undefined ? { committedTurnCount: input.committedTurnCount } : {}),
        status: 'sent',
        timeoutMs: input.timeoutMs,
        createdAt: now,
        updatedAt: now,
    };
    sessions.set(record.sessionId, record);
    sessionsByTarget.set(makeBaselineKey(record.vendor, record.targetId), record.sessionId);
    return record;
}

export function getSession(sessionId: string): WebAiSessionRecord | null {
    return sessions.get(sessionId) || null;
}

export function findSessionByTarget(vendor: WebAiVendor, targetId: string): WebAiSessionRecord | null {
    const id = sessionsByTarget.get(makeBaselineKey(vendor, targetId));
    if (!id) return null;
    return sessions.get(id) || null;
}

export function updateSessionStatus(sessionId: string, status: WebAiSessionStatus): WebAiSessionRecord | null {
    const record = sessions.get(sessionId);
    if (!record) return null;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return record;
}

export function clearSession(sessionId: string): void {
    const record = sessions.get(sessionId);
    if (!record) return;
    sessions.delete(sessionId);
    const targetKey = makeBaselineKey(record.vendor, record.targetId);
    if (sessionsByTarget.get(targetKey) === sessionId) sessionsByTarget.delete(targetKey);
}

export function assertSameTarget(record: WebAiSessionRecord, actualTargetId: string): void {
    if (record.targetId !== actualTargetId) {
        throw new WrongTargetError(record.targetId, actualTargetId);
    }
}

/** Test-only — clear all in-memory state. */
export function __resetSessionState(): void {
    baselines.clear();
    sessions.clear();
    sessionsByTarget.clear();
}
