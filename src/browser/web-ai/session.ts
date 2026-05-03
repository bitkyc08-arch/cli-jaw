import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JAW_HOME } from '../../core/config.js';
import type {
    CommittedTurnBaseline,
    QuestionEnvelope,
    WebAiNotificationEvent,
    WebAiNotificationStatus,
    WebAiSessionRecord,
    WebAiSessionStatus,
    WebAiSessionTabState,
    WebAiVendor,
} from './types.js';

const baselines = new Map<string, CommittedTurnBaseline>();
const sessions = new Map<string, WebAiSessionRecord>();
const notifications = new Map<string, WebAiNotificationEvent>();
const sessionsByTarget = new Map<string, string>();
let loadedPersistentStore = false;
const STORE_PATH = join(JAW_HOME, 'web-ai-sessions.json');
const ANSWER_EXCERPT_LIMIT = 400;

interface PersistentWebAiStore {
    baselines: CommittedTurnBaseline[];
    sessions: WebAiSessionRecord[];
    notifications?: WebAiNotificationEvent[];
}

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
    loadPersistentStore();
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
    savePersistentStore();
    return baseline;
}

export function getBaseline(vendor: WebAiVendor, targetId: string): CommittedTurnBaseline | null {
    loadPersistentStore();
    return baselines.get(makeBaselineKey(vendor, targetId)) || null;
}

export function clearBaseline(vendor: WebAiVendor, targetId: string): void {
    loadPersistentStore();
    baselines.delete(makeBaselineKey(vendor, targetId));
    savePersistentStore();
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
    notifyOnComplete?: boolean;
    capabilityMode?: string;
}

export function createSession(input: CreateSessionInput): WebAiSessionRecord {
    loadPersistentStore();
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
        ...(input.notifyOnComplete !== undefined ? { notifyOnComplete: input.notifyOnComplete } : {}),
        ...(input.capabilityMode ? { capabilityMode: input.capabilityMode } : {}),
        createdAt: now,
        updatedAt: now,
    };
    sessions.set(record.sessionId, record);
    sessionsByTarget.set(makeBaselineKey(record.vendor, record.targetId), record.sessionId);
    savePersistentStore();
    return record;
}

export function getSession(sessionId: string): WebAiSessionRecord | null {
    loadPersistentStore();
    return sessions.get(sessionId) || null;
}

export function findSessionByTarget(vendor: WebAiVendor, targetId: string): WebAiSessionRecord | null {
    loadPersistentStore();
    const id = sessionsByTarget.get(makeBaselineKey(vendor, targetId));
    if (!id) return null;
    return sessions.get(id) || null;
}

export function listSessions(input: { vendor?: WebAiVendor; status?: WebAiSessionStatus } = {}): WebAiSessionRecord[] {
    loadPersistentStore();
    return [...sessions.values()]
        .filter((session) => !input.vendor || session.vendor === input.vendor)
        .filter((session) => !input.status || session.status === input.status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateSessionStatus(sessionId: string, status: WebAiSessionStatus): WebAiSessionRecord | null {
    loadPersistentStore();
    const record = sessions.get(sessionId);
    if (!record) return null;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    savePersistentStore();
    return record;
}

export function setSessionNotifyOnComplete(sessionId: string, notifyOnComplete: boolean): WebAiSessionRecord | null {
    loadPersistentStore();
    const record = sessions.get(sessionId);
    if (!record) return null;
    record.notifyOnComplete = notifyOnComplete;
    record.updatedAt = new Date().toISOString();
    savePersistentStore();
    return record;
}

export function updateSessionResult(input: {
    sessionId: string;
    status: WebAiSessionStatus;
    url?: string;
    conversationUrl?: string;
    answerText?: string;
    error?: string;
    capabilityMode?: string;
    tabId?: string;
    tabState?: WebAiSessionTabState;
}): WebAiSessionRecord | null {
    loadPersistentStore();
    const record = sessions.get(input.sessionId);
    if (!record) return null;
    const now = new Date().toISOString();
    record.status = input.status;
    record.updatedAt = now;
    if (input.url) record.url = input.url;
    if (input.conversationUrl) record.conversationUrl = input.conversationUrl;
    if (input.capabilityMode) record.capabilityMode = input.capabilityMode;
    if (input.error) record.lastError = input.error;
    if (input.tabId) record.tabId = input.tabId;
    if (input.tabState) record.tabState = input.tabState;
    if (input.answerText !== undefined) {
        record.answerText = input.answerText;
        record.lastSeenTextHash = createHash('sha256').update(input.answerText).digest('hex');
    }
    if (input.status === 'complete') record.completedAt = now;
    if (input.status === 'error') record.failedAt = now;
    if (input.status === 'timeout') record.staleAt = now;
    if (record.notifyOnComplete && input.status === 'complete' && input.answerText) {
        enqueueSessionNotification({
            record,
            type: 'web-ai.answer.completed',
            answerText: input.answerText,
        });
    }
    savePersistentStore();
    return record;
}

export function enqueueWebAiSessionNotification(input: {
    sessionId: string;
    type: WebAiNotificationEvent['type'];
    answerText?: string;
    reason?: string;
    error?: string;
    capabilityMode?: string;
    elapsedMs?: number;
}): WebAiNotificationEvent | null {
    loadPersistentStore();
    const record = sessions.get(input.sessionId);
    if (!record) return null;
    const event = enqueueSessionNotification({
        record,
        type: input.type,
        answerText: input.answerText,
        reason: input.reason,
        error: input.error,
        capabilityMode: input.capabilityMode,
        elapsedMs: input.elapsedMs,
    });
    savePersistentStore();
    return event;
}

export function clearSession(sessionId: string): void {
    loadPersistentStore();
    const record = sessions.get(sessionId);
    if (!record) return;
    sessions.delete(sessionId);
    const targetKey = makeBaselineKey(record.vendor, record.targetId);
    if (sessionsByTarget.get(targetKey) === sessionId) sessionsByTarget.delete(targetKey);
    savePersistentStore();
}

export function pruneSessions(input: {
    olderThanMs?: number;
    before?: string;
    status?: WebAiSessionStatus;
} = {}): { removed: number; remaining: number } {
    loadPersistentStore();
    const cutoff = input.before
        ? Date.parse(input.before)
        : (typeof input.olderThanMs === 'number' && Number.isFinite(input.olderThanMs))
            ? Date.now() - input.olderThanMs
            : null;
    const toRemove: string[] = [];
    for (const [sessionId, record] of sessions) {
        if (input.status && record.status !== input.status) continue;
        const created = Date.parse(record.createdAt || '');
        if (cutoff !== null && Number.isFinite(created) && created < cutoff) {
            toRemove.push(sessionId);
        }
    }
    for (const sessionId of toRemove) {
        const record = sessions.get(sessionId);
        sessions.delete(sessionId);
        if (record) {
            const targetKey = makeBaselineKey(record.vendor, record.targetId);
            if (sessionsByTarget.get(targetKey) === sessionId) sessionsByTarget.delete(targetKey);
        }
    }
    if (toRemove.length > 0) savePersistentStore();
    return { removed: toRemove.length, remaining: sessions.size };
}

export function assertSameTarget(record: WebAiSessionRecord, actualTargetId: string): void {
    if (record.targetId !== actualTargetId) {
        throw new WrongTargetError(record.targetId, actualTargetId);
    }
}

export function bindSessionToTab(sessionId: string, targetId: string, tabId?: string): WebAiSessionRecord | null {
    const now = new Date().toISOString();
    return updateSessionResult({
        sessionId,
        status: 'sent',
        tabId: tabId || targetId,
        tabState: {
            createdAt: now,
            lastActiveAt: now,
            recoveryCount: 0,
            closeCount: 0,
        },
    });
}

export function updateSessionTabState(sessionId: string, updates: Partial<WebAiSessionTabState>): WebAiSessionRecord | null {
    const session = getSession(sessionId);
    if (!session) return null;
    const current = session.tabState || { createdAt: session.createdAt, lastActiveAt: session.createdAt, recoveryCount: 0, closeCount: 0 };
    return updateSessionResult({
        sessionId,
        status: session.status,
        tabState: { ...current, ...updates, lastActiveAt: new Date().toISOString() },
    });
}

export function incrementRecoveryCount(sessionId: string): WebAiSessionRecord | null {
    const session = getSession(sessionId);
    if (!session) return null;
    const current = session.tabState?.recoveryCount || 0;
    return updateSessionTabState(sessionId, { recoveryCount: current + 1 });
}

export function listNotifications(input: {
    vendor?: WebAiVendor;
    status?: WebAiNotificationStatus;
    sessionId?: string;
} = {}): WebAiNotificationEvent[] {
    loadPersistentStore();
    return [...notifications.values()]
        .filter((event) => !input.vendor || event.vendor === input.vendor)
        .filter((event) => !input.status || event.status === input.status)
        .filter((event) => !input.sessionId || event.sessionId === input.sessionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markNotificationDelivered(input: {
    eventId: string;
    status: WebAiNotificationStatus;
    error?: string;
}): WebAiNotificationEvent | null {
    loadPersistentStore();
    const event = notifications.get(input.eventId);
    if (!event) return null;
    event.status = input.status;
    event.deliveredAt = new Date().toISOString();
    if (input.error) event.error = input.error;
    savePersistentStore();
    return event;
}

/** Test-only — clear all in-memory state. */
export function __resetSessionState(): void {
    baselines.clear();
    sessions.clear();
    notifications.clear();
    sessionsByTarget.clear();
    loadedPersistentStore = true;
    savePersistentStore();
}

function enqueueSessionNotification(input: {
    record: WebAiSessionRecord;
    type: WebAiNotificationEvent['type'];
    answerText?: string;
    reason?: string;
    error?: string;
    capabilityMode?: string;
    elapsedMs?: number;
}): WebAiNotificationEvent {
    const answerHash = input.answerText ? createHash('sha256').update(input.answerText).digest('hex') : undefined;
    const eventId = `${input.record.sessionId}:${input.type}`;
    const existing = notifications.get(eventId);
    if (existing) return existing;
    const record = input.record;
    const now = new Date().toISOString();
    const event: WebAiNotificationEvent = {
        eventId,
        type: input.type,
        vendor: record.vendor,
        sessionId: record.sessionId,
        url: record.url,
        ...(record.conversationUrl ? { conversationUrl: record.conversationUrl } : {}),
        status: 'pending',
        ...(input.answerText ? { answerExcerpt: excerptAnswer(input.answerText) } : {}),
        ...(answerHash ? { answerHash } : {}),
        ...(input.capabilityMode || record.capabilityMode ? { capabilityMode: input.capabilityMode || record.capabilityMode } : {}),
        elapsedMs: Math.max(0, input.elapsedMs ?? (Date.parse(now) - Date.parse(record.createdAt))),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.error ? { error: input.error } : {}),
        createdAt: now,
    };
    notifications.set(eventId, event);
    return event;
}

function excerptAnswer(answerText: string): string {
    const compact = answerText.replace(/\s+/g, ' ').trim();
    return compact.length > ANSWER_EXCERPT_LIMIT ? `${compact.slice(0, ANSWER_EXCERPT_LIMIT - 1)}…` : compact;
}

function loadPersistentStore(): void {
    if (loadedPersistentStore) return;
    loadedPersistentStore = true;
    if (!existsSync(STORE_PATH)) return;
    try {
        const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Partial<PersistentWebAiStore>;
        for (const baseline of parsed.baselines || []) {
            if (baseline.vendor && baseline.targetId) baselines.set(makeBaselineKey(baseline.vendor, baseline.targetId), baseline);
        }
        for (const session of parsed.sessions || []) {
            if (!session.sessionId || !session.vendor || !session.targetId) continue;
            sessions.set(session.sessionId, session);
            sessionsByTarget.set(makeBaselineKey(session.vendor, session.targetId), session.sessionId);
        }
        for (const event of parsed.notifications || []) {
            if (!event.eventId || !event.vendor || !event.sessionId) continue;
            notifications.set(event.eventId, event);
        }
    } catch {
        // Corrupt store must not silently create a false session; start empty and let callers fail closed.
        baselines.clear();
        sessions.clear();
        notifications.clear();
        sessionsByTarget.clear();
    }
}

function savePersistentStore(): void {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const payload: PersistentWebAiStore = {
        baselines: [...baselines.values()],
        sessions: [...sessions.values()],
        notifications: [...notifications.values()],
    };
    writeFileSync(STORE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}
